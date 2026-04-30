# AzureTTSStreaming — C# Streaming HD Voice Sample

A minimal C# console application that calls **Azure HD Neural Voice** (e.g. `en-US-Ava:DragonHDLatestNeural`) using the **streaming** synthesis API so audio data is received and written incrementally, without waiting for the full response before playback or file writing begins.

---

## Prerequisites

| Requirement | Details |
|---|---|
| .NET SDK | 8.0 or later |
| Azure subscription | With a **Cognitive Services / Speech** resource created |
| Speech key + region | Shown in the Azure portal under *Keys and Endpoint* |

---

## Quick start

```bash
cd AzureTTSStreaming

# Restore NuGet packages
dotnet restore

# Synthesize with default voice → output.wav
dotnet run -- --key <YOUR_KEY> --region <YOUR_REGION>

# Custom HD voice → custom file
dotnet run -- \
  --key   <YOUR_KEY>   \
  --region eastus       \
  --voice "en-GB-Sonia:DragonHDLatestNeural" \
  --locale en-GB        \
  --text  "Hello from Sonia!" \
  --output sonia.wav

# Stream directly to the default speaker
dotnet run -- --key <YOUR_KEY> --region <YOUR_REGION> --output -
```

On Windows, replace the line-continuation `\` with `^`.

---

## How streaming works

| Step | SDK call | What happens |
|---|---|---|
| 1 | `SpeechSynthesizer.StartSpeakingSsmlAsync(ssml)` | Request is sent; method returns **immediately** once the service starts streaming bytes back — synthesis may still be in progress. |
| 2 | `AudioDataStream.FromResult(result)` | Wraps the live audio stream returned by the service. |
| 3 | `dataStream.ReadData(buffer)` in a loop | Reads available PCM bytes chunk-by-chunk as they arrive, writing them to a WAV file or draining them while the speaker plays the audio. |

This is in contrast to `SpeakSsmlAsync`, which blocks until **all** audio has been synthesized before returning.

---

## Options

| Flag | Default | Description |
|---|---|---|
| `--key` | *(required)* | Azure Speech subscription key |
| `--region` | *(required)* | Azure region (e.g. `eastus`, `canadacentral`) |
| `--voice` | `en-US-Ava:DragonHDLatestNeural` | HD voice name |
| `--locale` | `en-US` | BCP-47 locale for the SSML `xml:lang` attribute |
| `--text` | *(built-in sample)* | Text to synthesize |
| `--output` | `output.wav` | Output WAV path; use `-` for speaker playback |

---

## Available HD voices (examples)

| Voice | Region / Locale |
|---|---|
| `en-US-Ava:DragonHDLatestNeural` | en-US |
| `en-US-Andrew:DragonHDLatestNeural` | en-US |
| `en-US-Andrew2:DragonHDLatestNeural` | en-US |
| `en-US-Serena:DragonHDLatestNeural` | en-US |
| `en-US-Brian:DragonHDLatestNeural` | en-US |
| `en-GB-Sonia:DragonHDLatestNeural` | en-GB |
| `en-GB-Ollie:DragonHDLatestNeural` | en-GB |

> **Note:** HD voice availability depends on your Azure region. Check the [Azure TTS voice gallery](https://speech.microsoft.com/portal/voicegallery) for the full list.

---

## Output format

The program requests **24 kHz, 16-bit, mono PCM** audio wrapped in a standard RIFF WAV container (`Riff24Khz16BitMonoPcm`). You can change the format by editing the `SetSpeechSynthesisOutputFormat` call in `Program.cs`.

---

## Project structure

```
AzureTTSStreaming/
├── AzureTTSStreaming.csproj   # .NET 8 project file, references Speech SDK
├── Program.cs                 # Streaming TTS implementation
└── README.md                  # This file
```
