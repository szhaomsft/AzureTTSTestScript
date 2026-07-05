#!/usr/bin/env python3
"""
Azure Voice Live API - Parallel Session Load Test Tool

Drives the Azure AI Voice Live API (Azure realtime model, e.g. ``gpt-realtime``)
with many concurrent WebSocket sessions using the ``azure-ai-voicelive`` async
SDK. Each session replays a WAV file as the user turn for a random number of
turns (2-10 by default), using manual turn control (append -> commit ->
response.create -> wait for response.done).

Per turn the tool measures:
  * response latency  - response.create -> response.done
  * first-audio latency (TTFB) - response.create -> first response.audio.delta

On Ctrl+C (or when --max-sessions is reached) it prints an SLA + latency report.

Docs:
  https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to#azure-realtime-model

Usage:
    python voicelive_load_test.py --wav sample.wav --sessions 10 \
        --endpoint wss://<res>.services.ai.azure.com --use-api-key --api-key KEY

    python voicelive_load_test.py --wav sample.wav --sessions 20 \
        --endpoint wss://<res>.services.ai.azure.com     # Entra ID (DefaultAzureCredential)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import os
import random
import signal
import statistics
import sys
import time
import wave
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import List, Optional, Tuple, Union

try:
    import audioop  # type: ignore
except ImportError:  # Python 3.13+ moved audioop out of stdlib
    try:
        import audioop_lts as audioop  # type: ignore
    except ImportError:
        audioop = None  # type: ignore

from azure.core.credentials import AzureKeyCredential
from azure.ai.voicelive.aio import connect
from azure.ai.voicelive.models import (
    AzureRealtimeNativeVoice,
    AzureRealtimeNativeVoiceName,
    AzureStandardVoice,
    InputAudioFormat,
    Modality,
    OpenAIVoiceName,
    OutputAudioFormat,
    RequestSession,
    ServerEventType,
)

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TARGET_SAMPLE_RATE = 24000  # Hz - Voice Live default input sampling rate
TARGET_SAMPLE_WIDTH = 2  # bytes (PCM16)
TARGET_CHANNELS = 1  # mono
CHUNK_DURATION_MS = 50  # audio append granularity


# ---------------------------------------------------------------------------
# ANSI colour helpers (graceful fallback on dumb terminals)
# ---------------------------------------------------------------------------


def _enable_windows_vt() -> None:
    """Best-effort enable ANSI escape processing on legacy Windows consoles."""
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        # ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004 on STD_OUTPUT_HANDLE (-11)
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        pass


def _force_utf8_stdout() -> None:
    """Best-effort switch stdout/stderr to UTF-8 so banners never crash."""
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(Exception):
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]


_enable_windows_vt()
_force_utf8_stdout()

_COLOR_SUPPORTED: bool = (
    hasattr(sys.stdout, "isatty") and sys.stdout.isatty() and os.environ.get("NO_COLOR") is None
)


def _ansi(code: str) -> str:
    return f"\033[{code}m" if _COLOR_SUPPORTED else ""


BOLD = _ansi("1")
DIM = _ansi("2")
RED = _ansi("31")
GREEN = _ansi("32")
YELLOW = _ansi("33")
BLUE = _ansi("34")
MAGENTA = _ansi("35")
CYAN = _ansi("36")
RESET = _ansi("0")
BG_GREEN = _ansi("42")
BG_BLUE = _ansi("44")
BG_MAGENTA = _ansi("45")


# ---------------------------------------------------------------------------
# Result records
# ---------------------------------------------------------------------------


class TurnStatus(Enum):
    SUCCESS = "success"
    TIMEOUT = "timeout"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class TurnResult:
    session_id: int
    turn_index: int
    status: TurnStatus
    response_latency_ms: float = 0.0
    first_audio_latency_ms: float = 0.0
    audio_bytes_received: int = 0
    input_audio_ms: float = 0.0
    input_wav: str = ""
    response_text: str = ""
    error_message: str = ""
    voicelive_session_id: str = "?"


@dataclass
class Metrics:
    """Thread/-task-safe-enough (single event loop) shared metrics store."""

    turns: List[TurnResult] = field(default_factory=list)
    sessions_started: int = 0
    sessions_completed: int = 0
    sessions_failed: int = 0

    def add_turn(self, result: TurnResult) -> None:
        self.turns.append(result)


# ---------------------------------------------------------------------------
# WAV loading / conversion
# ---------------------------------------------------------------------------


def load_wav_as_pcm16_mono(path: Path) -> bytes:
    """
    Load a WAV file and return raw PCM16 mono bytes resampled to 24 kHz.

    Uses the ``audioop`` module for width/channel/rate conversion.
    """
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        frame_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    if not frames:
        raise ValueError(f"WAV file '{path}' contains no audio frames.")

    needs_conversion = (
        sample_width != TARGET_SAMPLE_WIDTH
        or channels != TARGET_CHANNELS
        or frame_rate != TARGET_SAMPLE_RATE
    )
    if not needs_conversion:
        return frames

    if audioop is None:
        raise RuntimeError(
            f"WAV needs conversion (channels={channels}, width={sample_width}, "
            f"rate={frame_rate}) but the 'audioop' module is unavailable. "
            "Provide a 16-bit mono 24kHz WAV, or 'pip install audioop-lts' (Python 3.13+)."
        )

    # 1) normalise sample width to 16-bit
    if sample_width != TARGET_SAMPLE_WIDTH:
        frames = audioop.lin2lin(frames, sample_width, TARGET_SAMPLE_WIDTH)
        sample_width = TARGET_SAMPLE_WIDTH

    # 2) down-mix to mono
    if channels == 2:
        frames = audioop.tomono(frames, sample_width, 0.5, 0.5)
    elif channels != 1:
        raise ValueError(f"Unsupported channel count: {channels}")

    # 3) resample to target rate
    if frame_rate != TARGET_SAMPLE_RATE:
        frames, _ = audioop.ratecv(
            frames, sample_width, TARGET_CHANNELS, frame_rate, TARGET_SAMPLE_RATE, None
        )

    return frames


def pcm_duration_ms(pcm: bytes) -> float:
    return len(pcm) / (TARGET_SAMPLE_RATE * TARGET_SAMPLE_WIDTH) * 1000.0


# ---------------------------------------------------------------------------
# Session configuration
# ---------------------------------------------------------------------------


_NATIVE_VOICE_NAMES = {v.value for v in AzureRealtimeNativeVoiceName}
_OPENAI_VOICE_NAMES = {v.value for v in OpenAIVoiceName}

# Family-appropriate default voice used when --voice is not supplied.
_DEFAULT_VOICE = {
    "azure_realtime": "ava",
    "openai_realtime": "alloy",
    "cascade": "en-US-AvaNeural",
}


def classify_model(model: str) -> str:
    """Classify a Voice Live model into a voice family."""
    m = model.lower()
    if m.startswith("azure-realtime"):
        return "azure_realtime"
    if m.startswith("gpt-realtime"):
        return "openai_realtime"
    return "cascade"


def _looks_like_azure_voice(name: str) -> bool:
    lowered = name.lower()
    return "neural" in lowered or ":dragonhd" in lowered


def build_voice_config(voice: Optional[str], model: str):
    """
    Resolve a voice into the right typed config for the target model family.

    Voice types are model-specific:
      * ``azure-realtime``        -> AzureRealtimeNativeVoice (ava, andrew, ...)
                                     or an Azure Speech voice.
      * ``gpt-realtime[-mini]``   -> OpenAI voice string (alloy, echo, ...)
                                     or an Azure Speech voice. Native voices are
                                     NOT allowed.
      * cascade/text models       -> AzureStandardVoice (en-US-AvaNeural, HD ...).
                                     Native voices are NOT allowed.
    """
    family = classify_model(model)
    if not voice:
        voice = _DEFAULT_VOICE[family]
    lowered = voice.lower()

    if family == "azure_realtime":
        if lowered in _NATIVE_VOICE_NAMES:
            return AzureRealtimeNativeVoice(name=lowered)
        if _looks_like_azure_voice(voice):
            return AzureStandardVoice(name=voice)
        return voice

    # gpt-realtime / cascade: azure-realtime-native voices are rejected by the
    # service, so substitute a family-appropriate default with a clear warning.
    if lowered in _NATIVE_VOICE_NAMES:
        fallback = _DEFAULT_VOICE[family]
        print(
            f"{YELLOW}Voice '{voice}' is an azure-realtime-native voice and is not "
            f"valid for model '{model}'. Using '{fallback}' instead.{RESET}"
        )
        voice = fallback
        lowered = voice.lower()

    if lowered in _OPENAI_VOICE_NAMES:
        return voice
    if _looks_like_azure_voice(voice):
        return AzureStandardVoice(name=voice)
    return voice


def build_session(
    voice: Optional[str], instructions: str, model: str, agent_mode: bool = False
) -> RequestSession:
    """Build a manual-turn Voice Live session (server VAD disabled).

    In agent mode the model, instructions and voice are defined by the Azure AI
    Foundry agent, so they are omitted here; only the audio format and manual
    turn control are set. A voice may still be forced via ``--voice``.
    """
    if agent_mode:
        session_kwargs = dict(
            modalities=[Modality.TEXT, Modality.AUDIO],
            input_audio_format=InputAudioFormat.PCM16,
            output_audio_format=OutputAudioFormat.PCM16,
            input_audio_sampling_rate=TARGET_SAMPLE_RATE,
            turn_detection=None,
        )
        if voice:
            session_kwargs["voice"] = build_voice_config(voice, model)
        return RequestSession(**session_kwargs)
    return RequestSession(
        modalities=[Modality.TEXT, Modality.AUDIO],
        instructions=instructions,
        voice=build_voice_config(voice, model),
        input_audio_format=InputAudioFormat.PCM16,
        output_audio_format=OutputAudioFormat.PCM16,
        input_audio_sampling_rate=TARGET_SAMPLE_RATE,
        # Manual turn control for deterministic load generation.
        turn_detection=None,
    )


# ---------------------------------------------------------------------------
# Turn execution
# ---------------------------------------------------------------------------


async def stream_user_audio(conn, pcm: bytes, realtime: bool) -> None:
    """Append the WAV audio to the input buffer in ~50ms chunks."""
    chunk_bytes = int(TARGET_SAMPLE_RATE * TARGET_SAMPLE_WIDTH * CHUNK_DURATION_MS / 1000)
    for offset in range(0, len(pcm), chunk_bytes):
        chunk = pcm[offset : offset + chunk_bytes]
        audio_b64 = base64.b64encode(chunk).decode("ascii")
        await conn.input_audio_buffer.append(audio=audio_b64)
        if realtime:
            await asyncio.sleep(CHUNK_DURATION_MS / 1000)


async def run_turn(
    conn,
    session_id: int,
    turn_index: int,
    pcm: bytes,
    wav_name: str,
    realtime: bool,
    turn_timeout: float,
    stop_event: asyncio.Event,
) -> TurnResult:
    """Execute a single request/response turn and measure latency."""
    input_ms = pcm_duration_ms(pcm)
    try:
        await stream_user_audio(conn, pcm, realtime)
        await conn.input_audio_buffer.commit()

        request_time = time.perf_counter()
        await conn.response.create()

        first_audio_latency: Optional[float] = None
        audio_bytes = 0
        text_parts: List[str] = []

        while True:
            if stop_event.is_set():
                return TurnResult(
                    session_id, turn_index, TurnStatus.CANCELLED,
                    input_audio_ms=input_ms, input_wav=wav_name,
                )
            try:
                event = await asyncio.wait_for(conn.recv(), timeout=turn_timeout)
            except asyncio.TimeoutError:
                return TurnResult(
                    session_id,
                    turn_index,
                    TurnStatus.TIMEOUT,
                    input_audio_ms=input_ms,
                    input_wav=wav_name,
                    error_message=f"No response.done within {turn_timeout:.0f}s",
                )

            etype = event.type
            if etype == ServerEventType.RESPONSE_AUDIO_DELTA:
                if first_audio_latency is None:
                    first_audio_latency = (time.perf_counter() - request_time) * 1000
                delta = getattr(event, "delta", None)
                if isinstance(delta, str):
                    with contextlib.suppress(Exception):
                        audio_bytes += len(base64.b64decode(delta))
                elif isinstance(delta, (bytes, bytearray)):
                    audio_bytes += len(delta)
            elif etype in (
                ServerEventType.RESPONSE_AUDIO_TRANSCRIPT_DELTA,
                ServerEventType.RESPONSE_TEXT_DELTA,
            ):
                delta = getattr(event, "delta", None)
                if isinstance(delta, str):
                    text_parts.append(delta)
            elif etype == ServerEventType.RESPONSE_DONE:
                response_latency = (time.perf_counter() - request_time) * 1000
                resp = getattr(event, "response", None)
                status = getattr(resp, "status", None)
                status_value = getattr(status, "value", status)
                if status_value in ("failed", "cancelled", "incomplete"):
                    details = getattr(resp, "status_details", None)
                    err = getattr(details, "error", None)
                    reason = (
                        getattr(err, "message", None)
                        or getattr(details, "reason", None)
                        or (str(details) if details else None)
                        or str(status_value)
                    )
                    return TurnResult(
                        session_id,
                        turn_index,
                        TurnStatus.ERROR,
                        input_audio_ms=input_ms,
                        error_message=f"response {status_value}: {reason}"[:300],
                    )
                return TurnResult(
                    session_id=session_id,
                    turn_index=turn_index,
                    status=TurnStatus.SUCCESS,
                    response_latency_ms=response_latency,
                    first_audio_latency_ms=first_audio_latency or response_latency,
                    audio_bytes_received=audio_bytes,
                    input_audio_ms=input_ms,
                    input_wav=wav_name,
                    response_text="".join(text_parts).strip(),
                )
            elif etype == ServerEventType.ERROR:
                err = getattr(event, "error", None)
                msg = getattr(err, "message", str(err)) if err else "unknown error"
                return TurnResult(
                    session_id,
                    turn_index,
                    TurnStatus.ERROR,
                    input_audio_ms=input_ms,
                    input_wav=wav_name,
                    error_message=str(msg)[:300],
                )

    except Exception as exc:  # noqa: BLE001 - classify any transport/SDK failure
        return TurnResult(
            session_id,
            turn_index,
            TurnStatus.ERROR,
            input_audio_ms=input_ms,
            input_wav=wav_name,
            error_message=f"{type(exc).__name__}: {exc}"[:300],
        )


async def run_session(
    session_id: int,
    args: argparse.Namespace,
    credential: Union[AzureKeyCredential, "object"],
    clips: List[Tuple[str, bytes]],
    metrics: Metrics,
    stop_event: asyncio.Event,
) -> None:
    """Run one full conversation (2-10 turns) over a single WebSocket session."""
    num_turns = random.randint(args.min_turns, args.max_turns)
    metrics.sessions_started += 1

    print(
        f"{BOLD}{BG_GREEN}{_ansi('30')} >> SESSION {session_id:04d} START {RESET} "
        f"{GREEN}{num_turns} turns planned{RESET} "
        f"{DIM}({'agent=' + args.agent_name if args.agent_name else 'model=' + args.model}){RESET}",
        flush=True,
    )

    completed_turns = 0
    vl_session_id = "?"
    try:
        connect_kwargs = dict(endpoint=args.endpoint, credential=credential)
        if args.agent_name:
            connect_kwargs["agent_name"] = args.agent_name
            connect_kwargs["project_name"] = args.project_name
            if args.agent_version:
                connect_kwargs["agent_version"] = args.agent_version
            if args.conversation_id:
                connect_kwargs["conversation_id"] = args.conversation_id
        else:
            connect_kwargs["model"] = args.model
        async with connect(**connect_kwargs) as conn:
            await conn.session.update(
                session=build_session(
                    args.voice, args.instructions, args.model, bool(args.agent_name)
                )
            )

            # Wait for session.updated confirmation before driving turns.
            try:
                while True:
                    event = await asyncio.wait_for(conn.recv(), timeout=args.turn_timeout)
                    sess = getattr(event, "session", None)
                    if sess is not None and getattr(sess, "id", None):
                        vl_session_id = sess.id
                    if event.type == ServerEventType.SESSION_UPDATED:
                        break
                    if event.type == ServerEventType.ERROR:
                        raise RuntimeError(getattr(getattr(event, "error", None), "message", "session error"))
            except (asyncio.TimeoutError, RuntimeError) as exc:
                metrics.sessions_failed += 1
                print(
                    f"{BOLD}{RED} XX SESSION {session_id:04d} FAILED {RESET} "
                    f"{DIM}(voicelive_session_id={vl_session_id}){RESET} "
                    f"{RED}setup: {exc}{RESET}",
                    flush=True,
                )
                return

            print(
                f"  {DIM}session {session_id:04d} voicelive_session_id={vl_session_id}{RESET}",
                flush=True,
            )

            for turn_index in range(num_turns):
                if stop_event.is_set():
                    break
                wav_name, pcm = random.choice(clips)
                result = await run_turn(
                    conn,
                    session_id,
                    turn_index,
                    pcm,
                    wav_name,
                    args.realtime,
                    args.turn_timeout,
                    stop_event,
                )
                metrics.add_turn(result)
                result.voicelive_session_id = vl_session_id
                completed_turns += 1

                if result.status == TurnStatus.SUCCESS:
                    audio_ms = pcm_duration_ms(b"\x00" * result.audio_bytes_received)
                    text = result.response_text or "(no text)"
                    if len(text) > 200:
                        text = text[:200] + "..."
                    print(
                        f"  {DIM}session {session_id:04d}{RESET} turn {turn_index + 1}/{num_turns} "
                        f"{GREEN}ok{RESET} {DIM}wav={wav_name}{RESET} "
                        f"first-audio={result.first_audio_latency_ms:.0f}ms "
                        f"response={result.response_latency_ms:.0f}ms "
                        f"audio={audio_ms / 1000:.2f}s ({result.audio_bytes_received:,}B)\n"
                        f"    {DIM}text:{RESET} {text}",
                        flush=True,
                    )
                else:
                    print(
                        f"  {BOLD}{RED}session {session_id:04d}{RESET} turn {turn_index + 1}/{num_turns} "
                        f"{DIM}(voicelive_session_id={vl_session_id}){RESET} "
                        f"{RED}{result.status.value}{RESET} {DIM}{result.error_message}{RESET}",
                        flush=True,
                    )
                    if result.status in (TurnStatus.ERROR, TurnStatus.TIMEOUT):
                        break

        metrics.sessions_completed += 1
        print(
            f"{BOLD}{BG_BLUE}{_ansi('37')} ## SESSION {session_id:04d} END {RESET} "
            f"{BLUE}{completed_turns} turns completed{RESET}",
            flush=True,
        )
    except asyncio.CancelledError:
        print(f"{YELLOW} -- SESSION {session_id:04d} cancelled{RESET}", flush=True)
        raise
    except Exception as exc:  # noqa: BLE001
        metrics.sessions_failed += 1
        print(
            f"{BOLD}{RED} XX SESSION {session_id:04d} FAILED {RESET} "
            f"{DIM}(voicelive_session_id={vl_session_id}){RESET} {RED}{exc}{RESET}",
            flush=True,
        )


# ---------------------------------------------------------------------------
# Worker pool
# ---------------------------------------------------------------------------


async def worker(
    worker_id: int,
    args: argparse.Namespace,
    credential,
    clips: List[Tuple[str, bytes]],
    metrics: Metrics,
    stop_event: asyncio.Event,
    session_counter: "SessionCounter",
) -> None:
    """Continuously run sessions until stop_event is set or the cap is reached."""
    while not stop_event.is_set():
        session_id = session_counter.next()
        if session_id is None:
            break
        await run_session(session_id, args, credential, clips, metrics, stop_event)


class SessionCounter:
    """Hands out monotonically increasing session ids up to an optional cap."""

    def __init__(self, max_sessions: Optional[int]):
        self._n = 0
        self._max = max_sessions

    def next(self) -> Optional[int]:
        if self._max is not None and self._n >= self._max:
            return None
        self._n += 1
        return self._n


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def percentile(data: List[float], p: float) -> float:
    if not data:
        return 0.0
    k = (len(data) - 1) * (p / 100)
    f = int(k)
    c = min(f + 1, len(data) - 1)
    return data[f] + (k - f) * (data[c] - data[f])


def _latency_block(title: str, values: List[float]) -> None:
    if not values:
        return
    values = sorted(values)
    print(f"\n  {BOLD}{title}{RESET}")
    print(f"  {'Min':<24} {min(values):.0f} ms")
    print(f"  {'Mean':<24} {statistics.mean(values):.0f} ms")
    print(f"  {'p50':<24} {percentile(values, 50):.0f} ms")
    print(f"  {'p90':<24} {percentile(values, 90):.0f} ms")
    print(f"  {'p95':<24} {percentile(values, 95):.0f} ms")
    print(f"  {'p99':<24} {percentile(values, 99):.0f} ms")
    print(f"  {'Max':<24} {max(values):.0f} ms")


def print_report(metrics: Metrics, wall_elapsed: float, args: argparse.Namespace) -> None:
    turns = metrics.turns
    total_turns = len(turns)
    success = [t for t in turns if t.status == TurnStatus.SUCCESS]
    cancelled = [t for t in turns if t.status == TurnStatus.CANCELLED]
    # Client-cancelled turns (Ctrl+C mid-turn) are excluded from SLA accounting.
    counted = [t for t in turns if t.status != TurnStatus.CANCELLED]
    failed = [t for t in counted if t.status != TurnStatus.SUCCESS]

    hline = "=" * 64
    print(f"\n{BOLD}{CYAN}{hline}{RESET}")
    print(f"{BOLD}{CYAN}  VOICE LIVE LOAD TEST - SLA & LATENCY REPORT{RESET}")
    print(f"{BOLD}{CYAN}{hline}{RESET}")

    print(f"\n  {BOLD}Configuration{RESET}")
    if args.agent_name:
        print(f"  {'Mode':<24} agent")
        print(f"  {'Agent':<24} {args.agent_name}")
        print(f"  {'Project':<24} {args.project_name}")
        if args.agent_version:
            print(f"  {'Agent version':<24} {args.agent_version}")
        if args.voice:
            print(f"  {'Voice':<24} {args.voice}")
    else:
        display_voice = args.voice or _DEFAULT_VOICE[classify_model(args.model)]
        print(f"  {'Model':<24} {args.model}")
        print(f"  {'Voice':<24} {display_voice}")

    print(f"\n  {BOLD}Sessions{RESET}")
    print(f"  {'Started':<24} {metrics.sessions_started}")
    print(f"  {'Completed':<24} {GREEN}{metrics.sessions_completed}{RESET}")
    print(f"  {'Failed':<24} {RED if metrics.sessions_failed else GREEN}{metrics.sessions_failed}{RESET}")
    print(f"  {'Concurrency':<24} {args.sessions}")
    print(f"  {'Max sessions':<24} {args.max_sessions if args.max_sessions is not None else 'unlimited'}")
    print(f"  {'Wall-clock':<24} {wall_elapsed:.1f}s")

    print(f"\n  {BOLD}Turns{RESET}")
    print(f"  {'Total':<24} {total_turns}")
    print(f"  {'Successful':<24} {GREEN}{len(success)}{RESET}")
    print(f"  {'Failed':<24} {RED if failed else GREEN}{len(failed)}{RESET}")
    print(f"  {'Client-cancelled':<24} {YELLOW}{len(cancelled)}{RESET} {DIM}(excluded from SLA){RESET}")
    if counted:
        # SLA denominator excludes client-cancelled turns.
        sla_ok = len(success) * 100 / len(counted)
        colour = GREEN if sla_ok >= 99 else (YELLOW if sla_ok >= 95 else RED)
        print(f"  {'Success rate (SLA)':<24} {colour}{sla_ok:.2f}%{RESET} {DIM}({len(success)}/{len(counted)}){RESET}")
    if wall_elapsed > 0:
        print(f"  {'Turn throughput':<24} {total_turns / wall_elapsed:.2f} turns/s")

    _latency_block(
        "First-audio latency / TTFB (successful turns)",
        [t.first_audio_latency_ms for t in success],
    )
    _latency_block(
        "Response latency (successful turns)",
        [t.response_latency_ms for t in success],
    )

    if success:
        audio = [t.audio_bytes_received for t in success]
        print(f"\n  {BOLD}Response audio{RESET}")
        print(f"  {'Total bytes':<24} {sum(audio):,}")
        print(f"  {'Mean per turn':<24} {statistics.mean(audio):,.0f} bytes")

    if failed:
        counts: dict[str, int] = {}
        for t in failed:
            counts[t.status.value] = counts.get(t.status.value, 0) + 1
        print(f"\n  {BOLD}{RED}Failure breakdown{RESET}")
        for status, count in sorted(counts.items(), key=lambda x: -x[1]):
            print(f"  {status:<24} {RED}{count}{RESET}")
        print(f"\n  {BOLD}Sample errors:{RESET}")
        for t in failed[:5]:
            if t.error_message:
                print(
                    f"  {DIM}[s{t.session_id:04d}/t{t.turn_index}] "
                    f"voicelive_session_id={t.voicelive_session_id} "
                    f"{t.error_message[:110]}{RESET}"
                )

    print(f"\n{BOLD}{CYAN}{hline}{RESET}\n")


def export_csv(metrics: Metrics, filepath: str, args: argparse.Namespace) -> None:
    import csv

    if args.agent_name:
        model_label = f"agent:{args.agent_name}"
        display_voice = args.voice or ""
    else:
        model_label = args.model
        display_voice = args.voice or _DEFAULT_VOICE[classify_model(args.model)]
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "model",
                "voice",
                "session_id",
                "voicelive_session_id",
                "turn_index",
                "status",
                "response_latency_ms",
                "first_audio_latency_ms",
                "audio_bytes_received",
                "audio_duration_s",
                "input_audio_ms",
                "input_wav",
                "response_text",
                "error_message",
            ]
        )
        for t in metrics.turns:
            writer.writerow(
                [
                    model_label,
                    display_voice,
                    t.session_id,
                    t.voicelive_session_id,
                    t.turn_index,
                    t.status.value,
                    f"{t.response_latency_ms:.2f}",
                    f"{t.first_audio_latency_ms:.2f}",
                    t.audio_bytes_received,
                    f"{pcm_duration_ms(b'0' * t.audio_bytes_received) / 1000:.3f}",
                    f"{t.input_audio_ms:.2f}",
                    t.input_wav,
                    t.response_text,
                    t.error_message,
                ]
            )
    print(f"{GREEN}Per-turn results exported to {filepath}{RESET}")


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------


def build_credential(args: argparse.Namespace):
    if args.use_api_key:
        if not args.api_key:
            print(f"{RED}ERROR: --use-api-key set but no API key provided.{RESET}")
            sys.exit(1)
        return AzureKeyCredential(args.api_key)
    try:
        from azure.identity.aio import DefaultAzureCredential
    except ImportError:
        print(
            f"{RED}ERROR: Entra ID auth requires 'azure-identity'. "
            f"Install it or use --use-api-key.{RESET}"
        )
        sys.exit(1)
    return DefaultAzureCredential()


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def run_load_test(args: argparse.Namespace, clips: List[Tuple[str, bytes]]) -> None:
    metrics = Metrics()
    stop_event = asyncio.Event()
    credential = build_credential(args)
    counter = SessionCounter(args.max_sessions)

    loop = asyncio.get_running_loop()

    def _request_stop() -> None:
        if not stop_event.is_set():
            print(
                f"\n{BOLD}{BG_MAGENTA}{_ansi('37')} !! CTRL+C - draining active turns, "
                f"then reporting... {RESET}",
                flush=True,
            )
            stop_event.set()

    # SIGINT handling: prefer loop signal handler; fall back to signal.signal.
    sigint_installed = False
    with contextlib.suppress(NotImplementedError, RuntimeError, ValueError):
        loop.add_signal_handler(signal.SIGINT, _request_stop)
        sigint_installed = True
    if not sigint_installed:
        with contextlib.suppress(ValueError, OSError):
            signal.signal(signal.SIGINT, lambda *_: loop.call_soon_threadsafe(_request_stop))

    if args.agent_name:
        target = f"agent={args.agent_name} project={args.project_name}"
        if args.voice:
            target += f" voice={args.voice}"
    else:
        display_voice = args.voice or _DEFAULT_VOICE[classify_model(args.model)]
        target = f"model={args.model} voice={display_voice}"
    wav_summary = ", ".join(f"{n} ({pcm_duration_ms(p)/1000:.1f}s)" for n, p in clips)
    print(
        f"{BOLD}Azure Voice Live load test{RESET}\n"
        f"{DIM}endpoint={args.endpoint} {target}\n"
        f"sessions={args.sessions} turns={args.min_turns}-{args.max_turns} "
        f"wavs=[{wav_summary}] (random per turn) "
        f"pacing={'real-time' if args.realtime else 'max-speed'}{RESET}\n"
        f"{DIM}Press Ctrl+C to stop and print the SLA report.{RESET}\n"
    )

    wall_start = time.perf_counter()
    workers = [
        asyncio.create_task(
            worker(i, args, credential, clips, metrics, stop_event, counter)
        )
        for i in range(args.sessions)
    ]

    try:
        await asyncio.gather(*workers)
    except asyncio.CancelledError:
        pass
    except KeyboardInterrupt:
        _request_stop()
        with contextlib.suppress(Exception):
            await asyncio.gather(*workers, return_exceptions=True)
    finally:
        wall_elapsed = time.perf_counter() - wall_start
        if hasattr(credential, "close"):
            with contextlib.suppress(Exception):
                await credential.close()
        print_report(metrics, wall_elapsed, args)
        if args.csv:
            export_csv(metrics, args.csv, args)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Azure Voice Live API parallel-session load test (azure-ai-voicelive)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--wav",
        required=True,
        nargs="+",
        help="One or more WAV files replayed as the user turn. "
        "A file is chosen at random for each turn.",
    )
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("AZURE_VOICELIVE_ENDPOINT"),
        help="Voice Live endpoint, e.g. wss://<resource>.services.ai.azure.com "
        "(env: AZURE_VOICELIVE_ENDPOINT)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("AZURE_VOICELIVE_MODEL", "azure-realtime"),
        help="Voice Live model. Native speech-to-speech: azure-realtime "
        "(default), gpt-realtime, gpt-realtime-mini. Cascade/text models: "
        "gpt-4.1, gpt-4o, gpt-4o-mini, phi4-mm-realtime, etc. Ignored in agent "
        "mode (--agent-name).",
    )
    parser.add_argument(
        "--agent-name",
        default=os.environ.get("AZURE_VOICELIVE_AGENT_NAME"),
        help="Azure AI Foundry agent name. When set, the test connects in agent "
        "mode (model/instructions come from the agent) and --project-name is "
        "required. (env: AZURE_VOICELIVE_AGENT_NAME)",
    )
    parser.add_argument(
        "--project-name",
        default=os.environ.get("AZURE_VOICELIVE_PROJECT_NAME"),
        help="Azure AI Foundry project name (required with --agent-name). "
        "(env: AZURE_VOICELIVE_PROJECT_NAME)",
    )
    parser.add_argument(
        "--agent-version",
        default=os.environ.get("AZURE_VOICELIVE_AGENT_VERSION"),
        help="Optional Azure AI Foundry agent version.",
    )
    parser.add_argument(
        "--conversation-id",
        default=os.environ.get("AZURE_VOICELIVE_CONVERSATION_ID"),
        help="Optional Azure AI Foundry conversation ID to continue.",
    )
    parser.add_argument(
        "--voice",
        default=os.environ.get("AZURE_VOICELIVE_VOICE"),
        help="Output voice; auto-detected to match the --model family. Default "
        "depends on the model: azure-realtime -> ava, gpt-realtime -> alloy, "
        "cascade/text models -> en-US-AvaNeural. Native voices (ava, andrew, "
        "...) work only with azure-realtime; gpt-realtime uses OpenAI voices "
        "(alloy, echo, cedar, ...); cascade models use Azure Speech voices "
        "(en-US-AvaNeural or HD en-US-Ava:DragonHDLatestNeural).",
    )
    parser.add_argument(
        "--instructions",
        default=os.environ.get(
            "AZURE_VOICELIVE_INSTRUCTIONS",
            "You are a helpful assistant. Keep responses brief.",
        ),
        help="System instructions for the assistant.",
    )
    parser.add_argument("--sessions", type=int, default=5, help="Parallel session concurrency (default: 5)")
    parser.add_argument("--min-turns", type=int, default=2, help="Minimum turns per session (default: 2)")
    parser.add_argument("--max-turns", type=int, default=10, help="Maximum turns per session (default: 10)")
    parser.add_argument(
        "--max-sessions",
        type=int,
        default=None,
        help="Stop after this many total sessions (default: run until Ctrl+C)",
    )
    parser.add_argument(
        "--turn-timeout",
        type=float,
        default=30.0,
        help="Per-turn timeout in seconds waiting for response.done (default: 30)",
    )
    parser.add_argument(
        "--no-realtime",
        dest="realtime",
        action="store_false",
        help="Send audio as fast as possible instead of real-time paced.",
    )
    parser.set_defaults(realtime=True)
    parser.add_argument(
        "--use-api-key",
        action="store_true",
        default=os.environ.get("AZURE_VOICELIVE_USE_API_KEY", "").strip().lower() in {"1", "true", "yes"},
        help="Use API key auth instead of Entra ID (DefaultAzureCredential).",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("AZURE_VOICELIVE_API_KEY"),
        help="Voice Live API key (env: AZURE_VOICELIVE_API_KEY)",
    )
    parser.add_argument("--csv", default=None, metavar="FILE", help="Export per-turn results to CSV.")

    args = parser.parse_args()

    if not args.endpoint:
        parser.error("--endpoint is required (or set AZURE_VOICELIVE_ENDPOINT)")
    if args.sessions < 1:
        parser.error("--sessions must be >= 1")
    if not (1 <= args.min_turns <= args.max_turns):
        parser.error("require 1 <= --min-turns <= --max-turns")
    for w in args.wav:
        if not Path(w).is_file():
            parser.error(f"WAV file not found: {w}")
    if args.agent_name and not args.project_name:
        parser.error("--project-name is required when --agent-name is set")
    if args.project_name and not args.agent_name:
        parser.error("--agent-name is required when --project-name is set")

    return args


def main() -> None:
    args = parse_args()
    clips: List[Tuple[str, bytes]] = []
    try:
        for w in args.wav:
            path = Path(w)
            clips.append((path.name, load_wav_as_pcm16_mono(path)))
    except Exception as exc:  # noqa: BLE001
        print(f"{RED}ERROR loading WAV: {exc}{RESET}")
        sys.exit(1)

    try:
        asyncio.run(run_load_test(args, clips))
    except KeyboardInterrupt:
        # asyncio.run may re-raise if Ctrl+C fires during shutdown.
        print(f"\n{YELLOW}Interrupted.{RESET}")


if __name__ == "__main__":
    main()
