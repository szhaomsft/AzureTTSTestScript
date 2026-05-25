# Foundry Agent Latency CLI

Command-line latency tester for Microsoft Foundry agents. It sends text queries to a Foundry agent through the Azure AI Projects SDK, streams the text response, and reports:

- TTFT: time to first text token
- TTLT: time to last text token
- Complete response time

## Setup

Install dependencies:

```powershell
Set-Location C:\Agents\AzureTTSTestScript\FoundryAgents
npm.cmd install
```

Create a local `.env` from the example:

```powershell
Copy-Item .\.env.example .\.env
```

Edit `C:\Agents\AzureTTSTestScript\FoundryAgents\.env` and set:

```text
AZURE_EXISTING_AIPROJECT_ENDPOINT="https://your-ai-services-account-name.services.ai.azure.com/api/projects/your-project-name"
AZURE_EXISTING_AGENT_ID="your-foundry-agent-name-or-name-colon-version-or-id"
```

Authenticate with Entra ID before running:

```powershell
az login
```

The signed-in account must have access to the Foundry project.

## Run

Run 10 text queries over one reused Foundry conversation:

```powershell
npm.cmd run latency -- --query "Tell me a story." --runs 10 --reuse-conversation --random-query
```

Run the default 100 queries:

```powershell
npm.cmd run latency -- --query "Tell me a story." --runs 100 --reuse-conversation --random-query
```

## Options

```text
--endpoint <url>       Foundry project endpoint. Defaults to FOUNDRY_PROJECT_ENDPOINT or AZURE_EXISTING_AIPROJECT_ENDPOINT.
--agent <name-or-id>   Foundry agent name, name:version, or ID. Defaults to FOUNDRY_AGENT or AZURE_EXISTING_AGENT_ID.
--query <text>         Text query to send.
--runs <n>             Number of test runs. Default: 100.
--timeout-ms <n>       Timeout per run. Default: 60000.
--inter-run-delay-ms <n> Delay between reused-conversation runs. Default: 250.
--csv <path>           Write per-run results to a CSV file.
--random-query         Append a unique random sentence to each query to avoid cache.
--reuse-conversation   Send all queries in one Foundry conversation instead of one conversation per run.
--allow-preview        Allow preview features on the OpenAI client agent endpoint config.
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
