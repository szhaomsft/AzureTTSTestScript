"""
Generate Azure HD Ava audio files for click-noise listening checks.

The built-in script exercises bracketed style prompts with Azure HD Ava and writes
the same utterance set to 24 kHz/48 kHz WAV, MP3, and raw PCM files.

Examples:
  python ava_hd_click_noise_check.py --key YOUR_KEY --region eastus
  python ava_hd_click_noise_check.py --voice en-us-ava:DragonHDV2.5Neural --iterations 3
"""

from __future__ import annotations

import argparse
import html
import os
import sys
from pathlib import Path


DEFAULT_LINES = [
    "[laughter] This is very funny.",
    "[whisper] I just don't know if I can handle this anymore, I confided softly, hoping no one else could hear.",
    "[shouting] Why can't anyone understand what I'm going through?",
    "[angry] It's so frustrating to feel like I'm shouting into a void!",
    "[sad] I just... I feel so alone in this, I finally admitted, my voice breaking as the sadness overwhelmed me.",
]

STYLE_MAP = {
    "laughter": "cheerful",
    "whisper": "whispering",
    "shouting": "shouting",
    "angry": "angry",
    "sad": "sad",
}

OUTPUT_FORMATS = {
    "24khz.wav": "Riff24Khz16BitMonoPcm",
    "48khz.wav": "Riff48Khz16BitMonoPcm",
    "24khz.mp3": "Audio24Khz160KBitRateMonoMp3",
    "48khz.mp3": "Audio48Khz192KBitRateMonoMp3",
    "24khz.raw": "Raw24Khz16BitMonoPcm",
    "48khz.raw": "Raw48Khz16BitMonoPcm",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Azure HD Ava style-prompt audio files for click-noise listening checks.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Credentials default to SUBSCRIPTION_SPEECH_KEY and "
            "SUBSCRIPTION_SPEECH_REGION when --key/--region are omitted."
        ),
    )
    parser.add_argument(
        "--key",
        default=os.getenv("SUBSCRIPTION_SPEECH_KEY", ""),
        help="Azure Speech subscription key.",
    )
    parser.add_argument(
        "--region",
        default=os.getenv("SUBSCRIPTION_SPEECH_REGION", "eastus"),
        help="Azure Speech region (default: env SUBSCRIPTION_SPEECH_REGION or eastus).",
    )
    parser.add_argument(
        "--voice",
        default="en-US-Ava:DragonHDLatestNeural",
        help="Azure HD Ava voice name (default: en-US-Ava:DragonHDLatestNeural).",
    )
    parser.add_argument(
        "--locale",
        default="en-US",
        help="SSML xml:lang locale (default: en-US).",
    )
    parser.add_argument(
        "--output",
        default="ava_click_noise_check",
        help="Output folder (default: ava_click_noise_check).",
    )
    parser.add_argument(
        "--prefix",
        default="ava_hd_style_click_check",
        help="Output filename prefix (default: ava_hd_style_click_check).",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=1,
        help="Number of times to synthesize each format (default: 1).",
    )
    parser.add_argument(
        "--style-mode",
        choices=("bracketed", "ssml"),
        default="bracketed",
        help=(
            "bracketed preserves [style] prompts exactly for HD voice testing; "
            "ssml maps supported tags to mstts:express-as (default: bracketed)."
        ),
    )
    return parser.parse_args()


def line_to_ssml_fragment(line: str, style_mode: str) -> str:
    if style_mode == "bracketed":
        return f"<s>{html.escape(line)}</s>"

    stripped = line.strip()
    if not stripped.startswith("[") or "]" not in stripped:
        return f"<s>{html.escape(stripped)}</s>"

    tag, text = stripped[1:].split("]", 1)
    style = STYLE_MAP.get(tag.strip().lower())
    escaped_text = html.escape(text.strip())
    if not style:
        return f"<s>{html.escape(stripped)}</s>"

    return f'<s><mstts:express-as style="{style}">{escaped_text}</mstts:express-as></s>'


def build_ssml(voice: str, locale: str, style_mode: str) -> str:
    fragments = []
    for line in DEFAULT_LINES:
        fragments.append(line_to_ssml_fragment(line, style_mode))
        fragments.append('<break time="450ms"/>')

    return (
        '<speak version="1.0" '
        'xmlns="http://www.w3.org/2001/10/synthesis" '
        'xmlns:mstts="https://www.w3.org/2001/mstts" '
        f'xml:lang="{html.escape(locale)}">'
        f'<voice name="{html.escape(voice)}">'
        f'{"".join(fragments)}'
        "</voice>"
        "</speak>"
    )


def load_speechsdk():
    try:
        import azure.cognitiveservices.speech as speechsdk
    except ModuleNotFoundError:
        print(
            "ERROR: Azure Speech SDK is not installed. Install it with:\n"
            "  python -m pip install azure-cognitiveservices-speech",
            file=sys.stderr,
        )
        sys.exit(1)
    return speechsdk


def synthesize_file(
    speechsdk,
    key: str,
    region: str,
    ssml: str,
    output_path: Path,
    output_format_name: str,
) -> None:
    speech_config = speechsdk.SpeechConfig(subscription=key, region=region)
    output_format = getattr(speechsdk.SpeechSynthesisOutputFormat, output_format_name)
    speech_config.set_speech_synthesis_output_format(output_format)

    audio_config = speechsdk.audio.AudioOutputConfig(filename=str(output_path))
    synthesizer = speechsdk.SpeechSynthesizer(
        speech_config=speech_config,
        audio_config=audio_config,
    )
    result = synthesizer.speak_ssml_async(ssml).get()

    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        return

    if result.reason == speechsdk.ResultReason.Canceled:
        details = result.cancellation_details
        raise RuntimeError(
            f"Synthesis canceled for {output_path.name}: "
            f"{details.reason}; {details.error_details or 'no error details'}"
        )

    raise RuntimeError(f"Synthesis failed for {output_path.name}: {result.reason}")


def main() -> int:
    args = parse_args()
    if not args.key:
        print(
            "ERROR: No Azure Speech key provided. Use --key or set SUBSCRIPTION_SPEECH_KEY.",
            file=sys.stderr,
        )
        return 1
    if args.iterations < 1:
        print("ERROR: --iterations must be 1 or greater.", file=sys.stderr)
        return 1

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    ssml = build_ssml(args.voice, args.locale, args.style_mode)
    ssml_path = output_dir / f"{args.prefix}.{args.style_mode}.ssml"
    ssml_path.write_text(ssml, encoding="utf-8")

    speechsdk = load_speechsdk()

    print(f"Voice:      {args.voice}")
    print(f"Region:     {args.region}")
    print(f"Style mode: {args.style_mode}")
    print(f"SSML:       {ssml_path}")
    print(f"Output:     {output_dir}")

    generated = []
    for iteration in range(1, args.iterations + 1):
        suffix = f"_iter{iteration:02d}" if args.iterations > 1 else ""
        for format_suffix, format_name in OUTPUT_FORMATS.items():
            output_path = output_dir / f"{args.prefix}{suffix}_{format_suffix}"
            print(f"Synthesizing {output_path.name} ...")
            synthesize_file(
                speechsdk,
                args.key,
                args.region,
                ssml,
                output_path,
                format_name,
            )
            generated.append(output_path)

    print("\nGenerated files:")
    for path in generated:
        print(f"  {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
