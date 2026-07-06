# Voice Live API — Parallel Session Load Test

`voicelive_load_test.py` drives the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to#azure-realtime-model)
(Azure realtime model, e.g. `gpt-realtime`) with many concurrent WebSocket
sessions using the async `azure-ai-voicelive` SDK.

Each session replays a WAV file as the user turn for a **random 2–10 turns**,
using manual turn control (`append → commit → response.create → response.done`).
Session **start** and **end** are printed as highlighted banners. On **Ctrl+C**
(or when `--max-sessions` is reached) it prints an **SLA + latency report**.

## Install

```powershell
pip install --pre azure-ai-voicelive azure-identity python-dotenv
# Python 3.13+ only, if the input WAV needs resampling/downmixing:
pip install audioop-lts
```

> Requires `azure-ai-voicelive` **>= 1.3.0b1** for the `azure-realtime` model's
> native voices (`AzureRealtimeNativeVoice`). Hence `--pre`.

## Metrics captured (per turn)

| Metric | Definition |
| --- | --- |
| First-audio latency (TTFB) | `response.create` → first `response.audio.delta` |
| Response latency | `response.create` → `response.done` |

The report shows min/mean/p50/p90/p95/p99/max for both, the turn **success
rate (SLA)**, throughput, and a failure breakdown. **Client-cancelled turns**
(from Ctrl+C mid-turn) are listed separately and **excluded from the SLA**
denominator so a graceful stop never penalises the results.

## Run

API key auth:

```powershell
python voicelive_load_test.py --wav sample.wav --sessions 10 `
  --endpoint wss://<resource>.services.ai.azure.com `
  --use-api-key --api-key <KEY>
```

Entra ID auth (`DefaultAzureCredential`, e.g. `az login`):

```powershell
python voicelive_load_test.py --wav sample.wav --sessions 20 `
  --endpoint wss://<resource>.services.ai.azure.com
```

Cap total sessions and export per-turn CSV:

```powershell
python voicelive_load_test.py --wav sample.wav --sessions 10 `
  --endpoint wss://<resource>.services.ai.azure.com --use-api-key --api-key <KEY> `
  --max-sessions 100 --csv results.csv
```

Multiple WAVs (a file is chosen at random for each turn):

```powershell
python voicelive_load_test.py --wav a.wav b.wav c.wav --sessions 10 `
  --endpoint wss://<resource>.services.ai.azure.com --use-api-key --api-key <KEY>
```

The chosen file per turn is shown in the log line (`wav=...`) and recorded in the
`input_wav` CSV column.

### Agent mode (Azure AI Foundry agent)

Instead of a model, connect to an [Azure AI Foundry agent](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to).
The model, instructions and (unless overridden) voice come from the agent, so
`--model`/`--instructions` are ignored. Entra ID auth is recommended.

```powershell
# az login first
python voicelive_load_test.py --wav a.wav b.wav --sessions 10 `
  --endpoint wss://<resource>.services.ai.azure.com `
  --agent-name <AGENT_NAME> --project-name <FOUNDRY_PROJECT>
```

`--agent-name` and `--project-name` are both required together. Optional:
`--agent-version`, `--conversation-id`, and `--voice` to force a voice. The
report and CSV show `agent:<name>` instead of a model.

Any 16-bit / 8-bit / stereo / arbitrary-sample-rate PCM WAV is accepted; it is
converted to 24 kHz mono PCM16 automatically. Audio is streamed real-time paced
by default (use `--no-realtime` to send as fast as possible).

Environment variables (`.env` supported): `AZURE_VOICELIVE_ENDPOINT`,
`AZURE_VOICELIVE_MODEL`, `AZURE_VOICELIVE_VOICE`, `AZURE_VOICELIVE_API_KEY`,
`AZURE_VOICELIVE_USE_API_KEY`, `AZURE_VOICELIVE_INSTRUCTIONS`,
`AZURE_VOICELIVE_AGENT_NAME`, `AZURE_VOICELIVE_PROJECT_NAME`,
`AZURE_VOICELIVE_AGENT_VERSION`, `AZURE_VOICELIVE_CONVERSATION_ID`,
`AZURE_VOICELIVE_TRAFFIC_TYPE`.

> **Traffic type** — every connection sends a `trafficType` URL query parameter
> (default `loadtest`, override with `--traffic-type` / `AZURE_VOICELIVE_TRAFFIC_TYPE`)
> which the service uses to tag its telemetry/logs for the run. Pass
> `--traffic-type ""` to omit it.

> **Voice** — the config type is auto-detected from the `--voice` name **and the
> `--model` family**, and the default voice depends on the model:
>
> | Model family | Example `--model` | Default `--voice` | Serialized as |
> | --- | --- | --- | --- |
> | Azure realtime (native S2S) | `azure-realtime` | `ava` | `AzureRealtimeNativeVoice` |
> | OpenAI realtime (S2S) | `gpt-realtime`, `gpt-realtime-mini` | `alloy` | raw OpenAI voice string |
> | Cascade (text / STT→LLM→TTS) | `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`, `phi4-mm-realtime` | `en-US-AvaNeural` | `AzureStandardVoice` |
>
> Native voices (`ava`, `andrew`, ...) are only valid with `azure-realtime`;
> passing one to another model prints a warning and falls back to that model's
> default. `gpt-realtime`/cascade models also accept Azure Speech voices
> (`en-US-AvaNeural`, HD `en-US-Ava:DragonHDLatestNeural`). For cascade models,
> Azure speech-to-text is applied to the input audio automatically. Examples:
>
> ```powershell
> # OpenAI realtime
> python voicelive_load_test.py --wav sample.wav --model gpt-realtime --voice alloy ...
> # Cascade text model with an Azure voice
> python voicelive_load_test.py --wav sample.wav --model gpt-4.1 --voice en-US-AvaNeural ...
> ```

Run `python voicelive_load_test.py --help` for all options.
