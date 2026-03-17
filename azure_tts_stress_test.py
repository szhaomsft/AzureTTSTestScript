#!/usr/bin/env python3
"""
Azure HD Voice (TTS) Stress Test Tool

Stress tests Azure Cognitive Services Text-to-Speech with HD neural voices
using the Azure Speech SDK with concurrent threads for parallel synthesis.

Usage:
    python azure_tts_stress_test.py --region eastus --subscription-key YOUR_KEY
    python azure_tts_stress_test.py --region eastus --concurrency 30 --total-requests 100
    python azure_tts_stress_test.py --region westeurope --concurrency 50 --timeout 5 --csv results.csv
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from threading import Lock
from typing import List, Optional

import azure.cognitiveservices.speech as speechsdk

# ---------------------------------------------------------------------------
# SSML payload pool — varied lengths for realistic load simulation
# ---------------------------------------------------------------------------

SSML_TEXTS: list[str] = [
    # Short (~1 sentence)
    "The quick brown fox jumps over the lazy dog near the riverbank.",
    # Short
    "Welcome to the Azure cloud platform. How can I help you today?",
    # Medium (~2-3 sentences)
    (
        "Thank you for calling our support line. Your estimated wait time is "
        "approximately two minutes. Please stay on the line and a representative "
        "will be with you shortly."
    ),
    # Medium
    (
        "Good morning! Today's weather forecast calls for partly cloudy skies "
        "with a high of seventy-two degrees. There is a thirty percent chance "
        "of afternoon showers, so you may want to carry an umbrella."
    ),
    # Medium-long
    (
        "Our quarterly earnings report shows a fifteen percent increase in "
        "revenue compared to the same period last year. Operating margins have "
        "improved by three percentage points, driven primarily by efficiency "
        "gains in our cloud services division and strong customer retention rates."
    ),
    # Long (~4-5 sentences)
    (
        "Artificial intelligence is transforming the way we interact with "
        "technology. From natural language processing to computer vision, "
        "AI systems are becoming increasingly capable of understanding and "
        "responding to human needs. As these technologies mature, we can expect "
        "to see even more innovative applications across healthcare, education, "
        "finance, and many other industries. The key challenge remains ensuring "
        "that these powerful tools are developed and deployed responsibly."
    ),
    # Long
    (
        "The history of space exploration is filled with remarkable achievements. "
        "From the first satellite launch in nineteen fifty-seven to the moon "
        "landing in nineteen sixty-nine, humanity has continually pushed the "
        "boundaries of what is possible. Today, private companies are joining "
        "national space agencies in the quest to explore Mars and beyond. "
        "The next decade promises to be the most exciting era of space travel yet."
    ),
    # Very long
    (
        "In the realm of modern software engineering, microservices architecture "
        "has emerged as a dominant paradigm for building scalable applications. "
        "By decomposing monolithic systems into smaller, independently deployable "
        "services, development teams can iterate faster and scale individual "
        "components based on demand. However, this approach introduces complexity "
        "in areas such as service discovery, distributed tracing, and data "
        "consistency. Organizations must carefully weigh these trade-offs when "
        "deciding whether to adopt a microservices strategy. Containerization "
        "technologies like Docker and orchestration platforms like Kubernetes "
        "have made it significantly easier to manage these distributed systems."
    ),
]


def build_ssml(text: str, voice: str) -> str:
    """Wrap plain text in an SSML envelope for Azure TTS."""
    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xml:lang="en-US">'
        f'<voice name="{voice}">{text}</voice>'
        "</speak>"
    )


# ---------------------------------------------------------------------------
# Result data model
# ---------------------------------------------------------------------------


class RequestStatus(Enum):
    SUCCESS = "success"
    TIMEOUT = "timeout"
    SDK_ERROR = "sdk_error"
    CANCELLED = "cancelled"


@dataclass
class RequestResult:
    request_id: int
    status: RequestStatus
    total_latency_ms: float = 0.0
    first_byte_latency_ms: float = 0.0
    audio_size_bytes: int = 0
    error_message: str = ""
    error_code: str = ""
    text_length: int = 0


# ---------------------------------------------------------------------------
# ANSI colour helpers (graceful fallback on dumb terminals / Windows)
# ---------------------------------------------------------------------------

_COLOR_SUPPORTED: bool = (
    hasattr(sys.stdout, "isatty")
    and sys.stdout.isatty()
    and os.environ.get("NO_COLOR") is None
)


def _ansi(code: str) -> str:
    return f"\033[{code}m" if _COLOR_SUPPORTED else ""


BOLD = _ansi("1")
RED = _ansi("31")
GREEN = _ansi("32")
YELLOW = _ansi("33")
CYAN = _ansi("36")
RESET = _ansi("0")
DIM = _ansi("2")


# ---------------------------------------------------------------------------
# TTS synthesis worker (runs in a thread)
# ---------------------------------------------------------------------------


def synthesise(
    request_id: int,
    region: str,
    subscription_key: str,
    ssml: str,
    text_length: int,
    per_request_timeout_ms: int,
    output_dir: Optional[Path],
    progress_callback,
) -> RequestResult:
    """
    Perform a single TTS synthesis using the Azure Speech SDK.

    Each call creates its own SpeechSynthesizer so that requests are fully
    independent and can run safely in parallel threads.
    """
    speech_config = speechsdk.SpeechConfig(
        subscription=subscription_key, region=region
    )
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3
    )

    # Synthesise to in-memory stream (no file/speaker output)
    if output_dir is not None:
        out_file = str(output_dir / f"tts_{request_id:05d}.mp3")
        audio_config = speechsdk.audio.AudioOutputConfig(filename=out_file)
    else:
        audio_config = None  # pull-stream / in-memory

    synthesizer = speechsdk.SpeechSynthesizer(
        speech_config=speech_config, audio_config=audio_config
    )

    # Track first-byte latency via the synthesizing event
    first_byte_time: Optional[float] = None

    def on_synthesizing(evt: speechsdk.SessionEventArgs):
        nonlocal first_byte_time
        if first_byte_time is None:
            first_byte_time = time.monotonic()

    synthesizer.synthesizing.connect(on_synthesizing)

    start = time.monotonic()

    try:
        result = synthesizer.speak_ssml(ssml)
        total_latency_ms = (time.monotonic() - start) * 1000
        fb_latency_ms = (
            (first_byte_time - start) * 1000 if first_byte_time else total_latency_ms
        )

        if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
            audio_data = result.audio_data
            req_result = RequestResult(
                request_id=request_id,
                status=RequestStatus.SUCCESS,
                total_latency_ms=total_latency_ms,
                first_byte_latency_ms=fb_latency_ms,
                audio_size_bytes=len(audio_data) if audio_data else 0,
                text_length=text_length,
            )
        elif result.reason == speechsdk.ResultReason.Canceled:
            cancellation = result.cancellation_details
            error_code = str(cancellation.error_code) if cancellation.error_code else ""
            error_msg = cancellation.error_details or cancellation.reason.name

            # Classify the error
            if "timeout" in error_msg.lower() or "Timeout" in error_code:
                status = RequestStatus.TIMEOUT
            elif cancellation.reason == speechsdk.CancellationReason.CancelledByUser:
                status = RequestStatus.CANCELLED
            else:
                status = RequestStatus.SDK_ERROR

            req_result = RequestResult(
                request_id=request_id,
                status=status,
                total_latency_ms=total_latency_ms,
                first_byte_latency_ms=fb_latency_ms,
                error_message=error_msg[:300],
                error_code=error_code,
                text_length=text_length,
            )
        else:
            req_result = RequestResult(
                request_id=request_id,
                status=RequestStatus.SDK_ERROR,
                total_latency_ms=total_latency_ms,
                error_message=f"Unexpected result reason: {result.reason}",
                text_length=text_length,
            )

    except Exception as exc:
        total_latency_ms = (time.monotonic() - start) * 1000
        req_result = RequestResult(
            request_id=request_id,
            status=RequestStatus.SDK_ERROR,
            total_latency_ms=total_latency_ms,
            error_message=f"{type(exc).__name__}: {exc}"[:300],
            text_length=text_length,
        )

    finally:
        # Clean up the synthesizer to release the connection
        del synthesizer

    progress_callback(req_result)
    return req_result


# ---------------------------------------------------------------------------
# Concurrency controller
# ---------------------------------------------------------------------------


def run_stress_test(
    region: str,
    subscription_key: str,
    concurrency: int,
    total_requests: int,
    voice: str,
    per_request_timeout_ms: int,
    output_dir: Optional[Path],
) -> List[RequestResult]:
    """Launch all synthesis tasks via a thread pool."""

    # Validate credentials early with a minimal synthesis
    print(f"{CYAN}Validating credentials with test synthesis ...{RESET}")
    try:
        test_config = speechsdk.SpeechConfig(
            subscription=subscription_key, region=region
        )
        test_config.set_speech_synthesis_output_format(
            speechsdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3
        )
        test_synth = speechsdk.SpeechSynthesizer(
            speech_config=test_config, audio_config=None
        )
        test_ssml = build_ssml("Test.", voice)
        test_result = test_synth.speak_ssml(test_ssml)
        if test_result.reason == speechsdk.ResultReason.Canceled:
            details = test_result.cancellation_details
            print(
                f"{RED}ERROR: Credential / config validation failed:\n"
                f"  Reason : {details.reason.name}\n"
                f"  Code   : {details.error_code}\n"
                f"  Details: {details.error_details}{RESET}"
            )
            sys.exit(1)
        del test_synth
    except Exception as exc:
        print(f"{RED}ERROR: {exc}{RESET}")
        sys.exit(1)

    print(f"{GREEN}Credentials validated successfully.{RESET}\n")

    # Pre-build SSML payloads with random text selection
    payloads: list[tuple[str, int]] = []
    for _ in range(total_requests):
        text = random.choice(SSML_TEXTS)
        ssml = build_ssml(text, voice)
        payloads.append((ssml, len(text)))

    print(
        f"{BOLD}Starting stress test:{RESET} "
        f"{total_requests} requests, concurrency={concurrency}, "
        f"timeout={per_request_timeout_ms}ms, voice={voice}\n"
    )

    # Progress tracking (thread-safe)
    completed_count = 0
    progress_lock = Lock()

    def progress_callback(result: RequestResult) -> None:
        nonlocal completed_count
        with progress_lock:
            completed_count += 1
            c = completed_count
        if c % max(1, total_requests // 20) == 0 or c == total_requests:
            pct = c * 100 // total_requests
            bar_filled = pct // 5
            bar = "#" * bar_filled + "-" * (20 - bar_filled)
            status_char = (
                f"{GREEN}ok{RESET}"
                if result.status == RequestStatus.SUCCESS
                else f"{RED}FAIL{RESET}"
            )
            print(
                f"\r  [{bar}] {pct:3d}%  ({c}/{total_requests}) "
                f"last: {status_char} {result.total_latency_ms:.0f}ms   ",
                end="",
                flush=True,
            )

    wall_start = time.monotonic()

    results: list[RequestResult] = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(
                synthesise,
                request_id=i,
                region=region,
                subscription_key=subscription_key,
                ssml=ssml,
                text_length=text_len,
                per_request_timeout_ms=per_request_timeout_ms,
                output_dir=output_dir,
                progress_callback=progress_callback,
            ): i
            for i, (ssml, text_len) in enumerate(payloads)
        }

        for future in as_completed(futures):
            try:
                result = future.result()
                results.append(result)
            except Exception as exc:
                req_id = futures[future]
                results.append(
                    RequestResult(
                        request_id=req_id,
                        status=RequestStatus.SDK_ERROR,
                        error_message=f"Thread exception: {exc}"[:300],
                    )
                )

    wall_elapsed = time.monotonic() - wall_start
    print("\n")

    # Sort by request_id for deterministic output
    results.sort(key=lambda r: r.request_id)
    return results


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def percentile(data: list[float], p: float) -> float:
    """Compute the p-th percentile (0-100) of a sorted list."""
    if not data:
        return 0.0
    k = (len(data) - 1) * (p / 100)
    f = int(k)
    c = f + 1
    if c >= len(data):
        return data[f]
    return data[f] + (k - f) * (data[c] - data[f])


def print_report(results: list[RequestResult], wall_elapsed: float | None = None) -> None:
    """Print a colour-coded summary report to the console."""
    total = len(results)
    if total == 0:
        print(f"{YELLOW}No results to report.{RESET}")
        return

    success = [r for r in results if r.status == RequestStatus.SUCCESS]
    failed = [r for r in results if r.status != RequestStatus.SUCCESS]
    timed_out = [r for r in results if r.status == RequestStatus.TIMEOUT]

    # Latency stats — only for successful requests
    latencies = sorted(r.total_latency_ms for r in success)
    fb_latencies = sorted(r.first_byte_latency_ms for r in success)

    # Error breakdown
    error_counts: dict[str, int] = {}
    for r in failed:
        key = r.status.value
        if r.error_code:
            key += f" ({r.error_code})"
        error_counts[key] = error_counts.get(key, 0) + 1

    # Wall-clock duration
    all_latencies = [r.total_latency_ms for r in results]
    if wall_elapsed is None:
        wall_elapsed = sum(all_latencies) / 1000  # rough fallback

    rps = total / wall_elapsed if wall_elapsed > 0 else 0

    # --- Print ---
    hline = "-" * 60
    print(f"{BOLD}{CYAN}{hline}{RESET}")
    print(f"{BOLD}{CYAN}  STRESS TEST RESULTS{RESET}")
    print(f"{BOLD}{CYAN}{hline}{RESET}")

    print(f"\n  {BOLD}Overview{RESET}")
    print(f"  {'Total requests':<28} {total}")
    print(f"  {'Successful':<28} {GREEN}{len(success)}{RESET}")
    print(f"  {'Failed':<28} {RED if failed else GREEN}{len(failed)}{RESET}")
    print(f"  {'Timed out':<28} {RED if timed_out else GREEN}{len(timed_out)}{RESET}")
    print(f"  {'Wall-clock duration':<28} {wall_elapsed:.2f}s")
    print(f"  {'Throughput':<28} {rps:.2f} req/s")

    if latencies:
        print(f"\n  {BOLD}Latency - Total (successful requests){RESET}")
        print(f"  {'Min':<28} {min(latencies):.1f} ms")
        print(f"  {'Max':<28} {max(latencies):.1f} ms")
        print(f"  {'Mean':<28} {statistics.mean(latencies):.1f} ms")
        if len(latencies) >= 2:
            print(f"  {'Std Dev':<28} {statistics.stdev(latencies):.1f} ms")
        print(f"  {'p50':<28} {percentile(latencies, 50):.1f} ms")
        print(f"  {'p90':<28} {percentile(latencies, 90):.1f} ms")
        print(f"  {'p95':<28} {percentile(latencies, 95):.1f} ms")
        print(f"  {'p99':<28} {percentile(latencies, 99):.1f} ms")

    if fb_latencies:
        print(f"\n  {BOLD}Latency - First Byte (successful requests){RESET}")
        print(f"  {'Min':<28} {min(fb_latencies):.1f} ms")
        print(f"  {'Max':<28} {max(fb_latencies):.1f} ms")
        print(f"  {'Mean':<28} {statistics.mean(fb_latencies):.1f} ms")
        print(f"  {'p50':<28} {percentile(fb_latencies, 50):.1f} ms")
        print(f"  {'p95':<28} {percentile(fb_latencies, 95):.1f} ms")

    if success:
        sizes = [r.audio_size_bytes for r in success]
        print(f"\n  {BOLD}Audio Output{RESET}")
        print(f"  {'Total audio bytes':<28} {sum(sizes):,}")
        print(f"  {'Mean audio size':<28} {statistics.mean(sizes):,.0f} bytes")
        print(f"  {'Min / Max size':<28} {min(sizes):,} / {max(sizes):,} bytes")

    if error_counts:
        print(f"\n  {BOLD}{RED}Error Breakdown{RESET}")
        for err_type, count in sorted(error_counts.items(), key=lambda x: -x[1]):
            print(f"  {err_type:<40} {RED}{count}{RESET}")

        # Show first few error messages for debugging
        print(f"\n  {BOLD}Sample error messages:{RESET}")
        shown = 0
        for r in failed:
            if shown >= 5:
                break
            print(f"  {DIM}  [#{r.request_id}] {r.error_message[:120]}{RESET}")
            shown += 1

    print(f"\n{BOLD}{CYAN}{hline}{RESET}\n")


def export_csv(results: list[RequestResult], filepath: str) -> None:
    """Write per-request results to a CSV file."""
    fieldnames = [
        "request_id",
        "status",
        "error_code",
        "total_latency_ms",
        "first_byte_latency_ms",
        "audio_size_bytes",
        "text_length",
        "error_message",
    ]
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in results:
            writer.writerow(
                {
                    "request_id": r.request_id,
                    "status": r.status.value,
                    "error_code": r.error_code,
                    "total_latency_ms": f"{r.total_latency_ms:.2f}",
                    "first_byte_latency_ms": f"{r.first_byte_latency_ms:.2f}",
                    "audio_size_bytes": r.audio_size_bytes,
                    "text_length": r.text_length,
                    "error_message": r.error_message,
                }
            )
    print(f"{GREEN}Results exported to {filepath}{RESET}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Azure HD Voice (TTS) Stress Test Tool (Speech SDK)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s --region eastus --subscription-key KEY --concurrency 2 --total-requests 5\n"
            "  %(prog)s --region eastus --concurrency 30 --total-requests 100\n"
            "  %(prog)s --region westeurope --concurrency 50 --timeout 5 --csv results.csv\n"
        ),
    )
    parser.add_argument(
        "--region",
        required=True,
        help="Azure region slug (e.g. eastus, westeurope, southeastasia)",
    )
    parser.add_argument(
        "--subscription-key",
        default=None,
        help="Azure Speech subscription key (default: env var AZURE_SPEECH_KEY)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=20,
        help="Number of parallel requests (1-50, default: 20)",
    )
    parser.add_argument(
        "--total-requests",
        type=int,
        default=100,
        help="Total synthesis requests to send (default: 100)",
    )
    parser.add_argument(
        "--voice",
        default="en-US-JennyMultilingualNeural",
        help="HD voice name (default: en-US-JennyMultilingualNeural)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Per-request timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to save audio files (default: discard audio)",
    )
    parser.add_argument(
        "--csv",
        default=None,
        metavar="FILE",
        help="Export per-request results to CSV file",
    )

    args = parser.parse_args()

    # Resolve subscription key
    if args.subscription_key is None:
        args.subscription_key = os.environ.get("AZURE_SPEECH_KEY")
    if not args.subscription_key:
        parser.error(
            "Subscription key required: use --subscription-key or set AZURE_SPEECH_KEY env var"
        )

    # Validate ranges
    if not 1 <= args.concurrency <= 50:
        parser.error("--concurrency must be between 1 and 50")
    if args.total_requests < 1:
        parser.error("--total-requests must be at least 1")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")

    # Prepare output directory
    if args.output_dir is not None:
        out = Path(args.output_dir)
        out.mkdir(parents=True, exist_ok=True)
        args.output_dir = out

    return args


def main() -> None:
    args = parse_args()

    print(f"\n{BOLD}Azure HD Voice (TTS) Stress Test (Speech SDK){RESET}")
    print(f"{DIM}Region: {args.region} | Voice: {args.voice}{RESET}\n")

    per_request_timeout_ms = int(args.timeout * 1000)

    wall_start = time.monotonic()

    results = run_stress_test(
        region=args.region,
        subscription_key=args.subscription_key,
        concurrency=args.concurrency,
        total_requests=args.total_requests,
        voice=args.voice,
        per_request_timeout_ms=per_request_timeout_ms,
        output_dir=args.output_dir,
    )

    wall_elapsed = time.monotonic() - wall_start

    print_report(results, wall_elapsed)

    if args.csv:
        export_csv(results, args.csv)

    # Exit with non-zero status if any requests failed
    failed_count = sum(1 for r in results if r.status != RequestStatus.SUCCESS)
    if failed_count:
        print(
            f"{YELLOW}!  {failed_count}/{len(results)} requests failed -- "
            f"review errors above.{RESET}\n"
        )
        sys.exit(1)
    else:
        print(f"{GREEN}All {len(results)} requests succeeded.{RESET}\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n{YELLOW}Interrupted by user.{RESET}")
        sys.exit(130)
