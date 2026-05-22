import argparse
import html
import os
import wave
from pathlib import Path

import azure.cognitiveservices.speech as speechsdk


DEFAULT_TEXT_FILES = {
    "en-US": Path("zeroshotbenchmark.txt"),
    "zh-CN": Path("zeroshotbenchmark_zh_cn.txt"),
}
DEFAULT_OUTPUT_DIRS = {
    "en-US": Path("mai_voice2_output"),
    "zh-CN": Path("mai_voice2_output_zh_cn"),
}
VOICES_BY_LOCALE = {
    "en-US": [
        "en-US-Ethan:MAI-Voice-2",
        "en-US-Grant:MAI-Voice-2",
        "en-US-Harper:MAI-Voice-2",
        "en-US-Iris:MAI-Voice-2",
        "en-US-Jasper:MAI-Voice-2",
        "en-US-Olivia:MAI-Voice-2",
    ],
    "zh-CN": [
        "zh-CN-Bo:MAI-Voice-2",
        "zh-CN-Mei:MAI-Voice-2",
    ],
}
SAMPLE_RATE = 24_000


def read_lines(path: Path) -> list[str]:
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return path.read_text(encoding=encoding).splitlines()
        except UnicodeDecodeError:
            continue

    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def build_ssml(text: str, voice_name: str) -> str:
    locale = voice_name.split("-", 2)[0] + "-" + voice_name.split("-", 2)[1]
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xml:lang="{locale}">'
        f'<voice name="{html.escape(voice_name)}">{html.escape(text)}</voice>'
        f"</speak>"
    )


def synthesize_text(
    speech_config: speechsdk.SpeechConfig,
    voice_name: str,
    ssml: str,
    output_file: Path,
) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    audio_config = speechsdk.audio.AudioOutputConfig(filename=str(output_file))
    synthesizer = speechsdk.SpeechSynthesizer(
        speech_config=speech_config,
        audio_config=audio_config,
    )

    result = synthesizer.speak_ssml_async(ssml).get()
    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        print(f"OK  {voice_name} -> {output_file}")
        return

    if result.reason == speechsdk.ResultReason.Canceled:
        cancellation = speechsdk.SpeechSynthesisCancellationDetails(result)
        raise RuntimeError(
            f"Azure TTS canceled for {voice_name}: "
            f"{cancellation.reason}; {cancellation.error_details}"
        )

    raise RuntimeError(f"Azure TTS failed for {voice_name}: {result.reason}")


def write_silence(output_file: Path, seconds: float = 0.5) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    frame_count = int(SAMPLE_RATE * seconds)
    with wave.open(str(output_file), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(b"\x00\x00" * frame_count)


def line_output_file(output_dir: Path, line_number: int) -> Path:
    return output_dir / f"{line_number:04d}.wav"


def line_ssml_file(output_dir: Path, line_number: int) -> Path:
    return output_dir / f"{line_number:04d}.ssml"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Synthesize one WAV per text line with Azure MAI Voice 2 voices, "
            "rotating voices across lines."
        )
    )
    parser.add_argument(
        "--locale",
        choices=sorted(VOICES_BY_LOCALE),
        default="en-US",
        help="Voice locale to use. Defaults to en-US.",
    )
    parser.add_argument(
        "--text-file",
        type=Path,
        help="Text file to synthesize. Defaults to the locale's benchmark file.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Output folder. Defaults to the locale's MAI Voice 2 output folder.",
    )
    parser.add_argument(
        "--voice",
        help=(
            "Optional full Azure voice name to use for every line, for example "
            "en-US-Ethan:MAI-Voice-2. If omitted, voices hard-coded for "
            "--locale are rotated across text lines."
        ),
    )
    parser.add_argument(
        "--list-voices",
        action="store_true",
        help="Print constructed voice names and exit without calling Azure TTS.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the line-to-voice/output mapping without calling Azure TTS.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    text_file = args.text_file or DEFAULT_TEXT_FILES[args.locale]
    output_dir = args.output_dir or DEFAULT_OUTPUT_DIRS[args.locale]

    if not text_file.is_file():
        raise FileNotFoundError(f"Text file not found: {text_file}")

    voices = [args.voice] if args.voice else VOICES_BY_LOCALE[args.locale]
    if not voices:
        raise RuntimeError(f"No voices configured for locale: {args.locale}")

    if args.list_voices:
        for voice in voices:
            print(voice)
        return

    lines = read_lines(text_file)
    if not lines:
        raise RuntimeError(f"Text file is empty: {text_file}")

    planned_outputs = [
        (line_number, line, voices[(line_number - 1) % len(voices)])
        for line_number, line in enumerate(lines, start=1)
    ]

    if args.dry_run:
        for line_number, _line, voice_name in planned_outputs:
            print(
                f"{line_number:04d}: {voice_name} -> "
                f"{line_output_file(output_dir, line_number)}"
            )
        print(f"Total WAV files: {len(planned_outputs)}")
        return

    speech_key = os.environ.get("AZURE_SPEECH_KEY")
    speech_region = os.environ.get("AZURE_SPEECH_REGION")
    if not speech_key or not speech_region:
        raise RuntimeError(
            "Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION before running this script."
        )

    speech_config = speechsdk.SpeechConfig(
        subscription=speech_key,
        region=speech_region,
    )
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm
    )

    for line_number, line, voice_name in planned_outputs:
        output_file = line_output_file(output_dir, line_number)
        ssml_file = line_ssml_file(output_dir, line_number)
        ssml = build_ssml(line, voice_name)
        ssml_file.parent.mkdir(parents=True, exist_ok=True)
        ssml_file.write_text(ssml, encoding="utf-8")
        if line.strip():
            synthesize_text(speech_config, voice_name, ssml, output_file)
        else:
            write_silence(output_file)
            print(f"OK  blank line -> {output_file}")


if __name__ == "__main__":
    main()
