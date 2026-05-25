# ElevenLabs Agent Latency CLI

Command-line latency tester for ElevenLabs conversational agents. It sends text queries to an agent, streams the text response, and reports:

- TTFT: time to first text token
- TTLT: time to last text token
- Complete response time

## Setup

Install dependencies:

```powershell
Set-Location C:\Agents\AzureTTSTestScript\ElevenLabsAgents
npm.cmd install
```

Create a local `.env` from the example:

```powershell
Copy-Item .\.env.example .\.env
```

Edit `.env` and set:

```text
ELEVENLABS_API_KEY="your-elevenlabs-api-key"
ELEVENLABS_AGENT="SimplePromptTextAgent"
```

Do not commit `.env`; it is ignored by the repository.

## Run

Run 10 text queries over one reused WebSocket session:

```powershell
npm.cmd run latency -- --query "Tell me a story." --runs 10 --reuse-session --no-text-override --random-query
```

Run the default 100 queries:

```powershell
npm.cmd run latency -- --query "Tell me a story." --runs 100 --reuse-session --no-text-override --random-query
```

## Options

```text
--api-key <key>       ElevenLabs API key. Defaults to ELEVENLABS_API_KEY.
--agent <name-or-id>  Agent name or agent_id. Defaults to ELEVENLABS_AGENT.
--query <text>        Text query to send.
--runs <n>            Number of test runs. Default: 100.
--timeout-ms <n>      Timeout per run. Default: 60000.
--warmup-ms <n>       Drain initial session events before first run. Default: 1000.
--inter-run-delay-ms <n> Drain late events between reused-session runs. Default: 250.
--api-base <url>      ElevenLabs API base URL. Default: https://api.elevenlabs.io.
--csv <path>          Write per-run results to a CSV file.
--random-query        Append a unique random sentence to each query to avoid cache.
--reuse-session       Send all queries in one conversation instead of opening one per run.
--no-text-override    Do not request text-only mode at conversation start.
```

## Output

Each run is separated and includes the query, streamed text output, timing metrics, and final response:

```text
===== Run 1 ==========
     query: Tell me a story. Random cache-buster sentence 1: ...
     stream: Hello! How can I help you today?
     ok, ttft=216.3 ms, ttlt=216.3 ms, complete=216.5 ms
     response: Hello! How can I help you today?
```

The summary prints average, min, p50, p95, and max for TTFT and TTLT.
