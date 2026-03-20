"""
LineSyn.py - Simple line-by-line Azure TTS synthesis script.

Takes a text script file (one sentence per line), synthesizes each line
using Azure Cognitive Services Speech SDK, and saves individual WAV files
plus an optional combined WAV.

Usage:
    python LineSyn.py script.txt --voice en-US-AvaMultilingualNeural --region eastus --key YOUR_KEY
    python LineSyn.py script.txt --voice en-US-AvaMultilingualNeural --region eastus --key YOUR_KEY --output out_folder
    python LineSyn.py script.txt --voice en-US-AvaMultilingualNeural --region eastus --key YOUR_KEY --threads 8 --no-merge
"""

import argparse
import os
import sys
import logging
import subprocess
import concurrent.futures

# Auto-install audioop-lts (needed by pydub on Python 3.13+)
try:
    import audioop
except ModuleNotFoundError:
    print("audioop not found (Python 3.13+), installing audioop-lts...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "audioop-lts"])

import azure.cognitiveservices.speech as speechsdk
from pydub import AudioSegment


def synthesize_line(speech_config, voice, text, output_file, locale="", deployment=None, logger=None):
    """
    Synthesize a single line of text to a WAV file using SSML.

    Args:
        speech_config: Azure SpeechConfig object.
        voice: Voice name (e.g. 'en-US-AvaMultilingualNeural').
        text: The text content to synthesize.
        output_file: Path to write the output .wav file.
        locale: Optional locale override (e.g. 'hi-IN'). Empty string = auto.
        deployment: Optional custom deployment/endpoint ID.
        logger: Logger for error reporting.

    Returns:
        True if synthesis succeeded, False otherwise.
    """
    text = text.strip()
    if not text:
        return False

    # Escape text for SSML
    text_escaped = text
    text_escaped = text_escaped.replace("&", "&amp;")
    text_escaped = text_escaped.replace("<", "&lt;")
    text_escaped = text_escaped.replace(">", "&gt;")
    text_escaped = text_escaped.replace("'", "&apos;")
    text_escaped = text_escaped.replace('"', "&quot;")

    # Build SSML
    ssml = f"<speak version='1.0' xml:lang='en-US'><voice name='{voice}'>"
    if locale:
        ssml += f"<lang xml:lang='{locale}'>"
    ssml += text_escaped
    if locale:
        ssml += "</lang>"
    ssml += "</voice></speak>"

    # Save SSML to file alongside the WAV
    ssml_file = os.path.splitext(output_file)[0] + ".ssml"
    with open(ssml_file, "w", encoding="utf-8") as sf:
        sf.write(ssml)

    # Set deployment if provided
    if deployment:
        speech_config.endpoint_id = deployment
    else:
        speech_config.endpoint_id = ""

    audio_output = speechsdk.audio.AudioOutputConfig(filename=output_file)
    synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=audio_output)

    result = synthesizer.speak_ssml_async(ssml).get()

    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        # Write audio data
        with open(output_file, "wb") as f:
            f.write(result.audio_data)
        print(f"  [OK] {os.path.basename(output_file)}: {text[:60]}...")
        return True
    else:
        error_msg = "Unknown error"
        if result.reason == speechsdk.ResultReason.Canceled:
            details = result.cancellation_details
            if details.reason == speechsdk.CancellationReason.Error:
                error_msg = f"Error: {details.error_details} (ID: {result.result_id})"
            else:
                error_msg = f"Canceled: {details.reason}"
        print(f"  [FAIL] {os.path.basename(output_file)}: {error_msg}")
        if logger:
            logger.error(f"Line: {text[:80]}... | File: {output_file} | {error_msg}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Synthesize a script file line-by-line to WAV using Azure TTS.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python LineSyn.py script.txt --voice en-US-AvaMultilingualNeural --region eastus --key YOUR_KEY
  python LineSyn.py script.txt --voice en-US-AvaMultilingualNeural --region eastus --key YOUR_KEY --output myout --threads 8
  python LineSyn.py script.txt --voice en-US-AvaMultilingualNeural --region eastus --key YOUR_KEY --no-merge
        """
    )

    parser.add_argument("script", type=str, help="Path to text file (one line per sentence).")
    parser.add_argument("--voice", type=str, required=True, help="Azure TTS voice name (e.g. en-US-AvaMultilingualNeural).")
    parser.add_argument("--region", type=str, default=None, help="Azure region (e.g. eastus). Falls back to SUBSCRIPTION_SPEECH_REGION env var.")
    parser.add_argument("--key", type=str, default=None, help="Azure Speech subscription key. Falls back to SUBSCRIPTION_SPEECH_KEY env var.")
    parser.add_argument("--output", type=str, default=".", help="Output folder for WAV files (default: current directory).")
    parser.add_argument("--locale", type=str, default="", help="Optional locale override (e.g. hi-IN).")
    parser.add_argument("--deployment", type=str, default=None, help="Optional custom deployment/endpoint ID.")
    parser.add_argument("--threads", type=int, default=4, help="Number of parallel synthesis threads (default: 4).")
    parser.add_argument("--no-merge", action="store_true", help="Skip merging individual WAVs into a combined file.")

    args = parser.parse_args()

    # --- Resolve credentials ---
    key = args.key or os.getenv("SUBSCRIPTION_SPEECH_KEY", "")
    region = args.region or os.getenv("SUBSCRIPTION_SPEECH_REGION", "eastus")

    if not key:
        print("ERROR: No Azure Speech key provided. Use --key or set SUBSCRIPTION_SPEECH_KEY env var.")
        sys.exit(1)

    # --- Validate input file ---
    if not os.path.isfile(args.script):
        print(f"ERROR: Script file not found: {args.script}")
        sys.exit(1)

    # --- Read lines ---
    with open(args.script, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # Strip whitespace, remove empty lines and comments (lines starting with #)
    lines = [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]

    if not lines:
        print("ERROR: Script file has no valid lines to synthesize.")
        sys.exit(1)

    print(f"Script: {args.script}")
    print(f"Voice:  {args.voice}")
    print(f"Region: {region}")
    print(f"Lines:  {len(lines)}")
    print(f"Threads: {args.threads}")

    # --- Output folder ---
    output_folder = args.output
    os.makedirs(output_folder, exist_ok=True)

    print(f"Output: {output_folder}")

    # --- Setup logger ---
    log_file = os.path.join(output_folder, "errors.log")
    logger = logging.getLogger("LineSyn")
    logger.setLevel(logging.ERROR)
    logger.handlers.clear()
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    logger.addHandler(fh)

    # --- Write script manifest ---
    manifest_file = os.path.join(output_folder, "script.txt")
    with open(manifest_file, "w", encoding="utf-8") as mf:
        for idx, line in enumerate(lines):
            mf.write(f"{str(idx).zfill(5)}\t{line}\n")

    # --- Setup Azure Speech config ---
    speech_config = speechsdk.SpeechConfig(subscription=key, region=region)
    speech_config.speech_synthesis_voice_name = args.voice
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm
    )

    # --- Synthesize lines in parallel ---
    print(f"\n--- Synthesizing {len(lines)} lines ---")
    success_count = 0
    fail_count = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.threads) as executor:
        future_to_idx = {}
        for idx, line in enumerate(lines):
            output_file = os.path.join(output_folder, f"{str(idx).zfill(5)}.wav")

            # Skip if already exists
            if os.path.exists(output_file):
                print(f"  [SKIP] {os.path.basename(output_file)} already exists")
                success_count += 1
                continue

            future = executor.submit(
                synthesize_line,
                speech_config,
                args.voice,
                line,
                output_file,
                locale=args.locale,
                deployment=args.deployment,
                logger=logger,
            )
            future_to_idx[future] = idx

        # Collect results
        for future in concurrent.futures.as_completed(future_to_idx):
            if future.result():
                success_count += 1
            else:
                fail_count += 1

    print(f"\n--- Synthesis complete ---")
    print(f"  Success: {success_count}")
    print(f"  Failed:  {fail_count}")

    # --- Merge WAVs ---
    if not args.no_merge:
        import glob as glob_mod

        wav_files = sorted(glob_mod.glob(os.path.join(output_folder, "[0-9]*.wav")))
        if wav_files:
            print(f"\nMerging {len(wav_files)} WAV files...")
            combined = AudioSegment.from_file(wav_files[0])
            for wf in wav_files[1:]:
                combined += AudioSegment.from_file(wf)

            combined_path = os.path.join(output_folder, "combined.wav")
            combined.export(combined_path, format="wav")
            duration_sec = len(combined) / 1000.0
            print(f"Combined WAV saved to: {combined_path}")
            print(f"Total duration: {duration_sec:.1f}s ({duration_sec/60:.1f}min)")
        else:
            print("No WAV files to merge.")

    print("\nDone.")


if __name__ == "__main__":
    main()
