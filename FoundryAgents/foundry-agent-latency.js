#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import OpenAI from "openai";

const DEFAULT_RUNS = 100;
const DEFAULT_QUERY = "Hello, please answer with one short sentence.";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_INTER_RUN_DELAY_MS = 250;

loadEnvFile(new URL(".env", import.meta.url));

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function usage() {
  console.log(`Usage:
  npm run latency -- --endpoint <project-endpoint> --agent <agent-name-or-version-or-id> [options]

Options:
  --endpoint <url>       Foundry project endpoint. Defaults to FOUNDRY_PROJECT_ENDPOINT or AZURE_EXISTING_AIPROJECT_ENDPOINT.
  --api-key <key>        Foundry/OpenAI protocol API key. Defaults to FOUNDRY_API_KEY, AZURE_AI_FOUNDRY_API_KEY, AZURE_AI_API_KEY, AZURE_AI_SERVICES_KEY, AZURE_EXISTING_AIPROJECT_KEY, or AZURE_OPENAI_API_KEY.
  --agent <name-or-id>   Foundry agent name, name:version, or ID. Defaults to FOUNDRY_AGENT or AZURE_EXISTING_AGENT_ID.
  --query <text>         Text query to send. Default: "${DEFAULT_QUERY}"
  --runs <n>             Number of test runs. Default: ${DEFAULT_RUNS}
  --timeout-ms <n>       Timeout per run. Default: ${DEFAULT_TIMEOUT_MS}
  --inter-run-delay-ms <n> Delay between reused-conversation runs. Default: ${DEFAULT_INTER_RUN_DELAY_MS}
  --csv <path>           Write per-run results to a CSV file.
  --random-query         Append a unique random sentence to each query to avoid cache.
  --reuse-conversation   Send all queries in one Foundry conversation instead of one conversation per run.
  --allow-preview        Allow preview features on the OpenAI client agent endpoint config.
  --help                 Show this help.

Examples:
  npm run latency -- --agent "support-agent" --query "What can you do?"
  $env:AZURE_EXISTING_AIPROJECT_ENDPOINT="..." ; az login ; npm run latency -- --agent "support-agent" --runs 100
`);
}

function parseArgs(argv) {
  const args = {
    endpoint: process.env.FOUNDRY_PROJECT_ENDPOINT ?? process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT,
    apiKey:
      process.env.FOUNDRY_API_KEY ??
      process.env.AZURE_AI_FOUNDRY_API_KEY ??
      process.env.AZURE_AI_API_KEY ??
      process.env.AZURE_AI_SERVICES_KEY ??
      process.env.AZURE_EXISTING_AIPROJECT_KEY ??
      process.env.AZURE_OPENAI_API_KEY,
    agent: process.env.FOUNDRY_AGENT ?? process.env.AZURE_EXISTING_AGENT_ID,
    query: DEFAULT_QUERY,
    runs: DEFAULT_RUNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    interRunDelayMs: DEFAULT_INTER_RUN_DELAY_MS,
    csv: undefined,
    randomQuery: false,
    reuseConversation: false,
    allowPreview: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case "--endpoint":
        args.endpoint = readValue().replace(/\/+$/, "");
        break;
      case "--api-key":
        args.apiKey = readValue();
        break;
      case "--agent":
        args.agent = readValue();
        break;
      case "--query":
        args.query = readValue();
        break;
      case "--runs":
        args.runs = parsePositiveInteger(readValue(), "--runs");
        break;
      case "--timeout-ms":
        args.timeoutMs = parsePositiveInteger(readValue(), "--timeout-ms");
        break;
      case "--inter-run-delay-ms":
        args.interRunDelayMs = parseNonNegativeInteger(readValue(), "--inter-run-delay-ms");
        break;
      case "--csv":
        args.csv = readValue();
        break;
      case "--random-query":
        args.randomQuery = true;
        break;
      case "--reuse-conversation":
        args.reuseConversation = true;
        break;
      case "--allow-preview":
        args.allowPreview = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function resolveAgent(project, agentReference) {
  const parsedReference = parseAgentReference(agentReference);
  try {
    if (parsedReference.version) {
      const agentVersion = await project.agents.getVersion(parsedReference.name, parsedReference.version);
      return {
        name: agentVersion.name ?? parsedReference.name,
        id: agentVersion.id,
        version: agentVersion.version ?? parsedReference.version,
      };
    }

    const agent = await project.agents.get(parsedReference.name);
    return { name: agent.name ?? parsedReference.name, id: agent.id, version: agent.version };
  } catch (error) {
    const suggestions = [];
    let matchedAgent;
    for await (const agent of project.agents.list({ limit: 10 })) {
      if (
        agent.name === agentReference ||
        agent.id === agentReference ||
        agent.name === parsedReference.name ||
        agent.id === parsedReference.name
      ) {
        matchedAgent = agent;
        break;
      }
      if (agent.name) {
        suggestions.push(agent.name);
      }
    }

    if (matchedAgent) {
      return {
        name: matchedAgent.name ?? parsedReference.name,
        id: matchedAgent.id,
        version: parsedReference.version ?? matchedAgent.version,
      };
    }

    throw new Error(
      `No Foundry agent named, versioned, or identified by "${agentReference}" found or accessible.` +
        (suggestions.length ? ` Available agents include: ${suggestions.join(", ")}` : "") +
        ` Original error: ${error.message}`
    );
  }
}

function parseAgentReference(agentReference) {
  const separator = agentReference.lastIndexOf(":");
  if (separator <= 0 || separator === agentReference.length - 1) {
    return { name: agentReference, version: undefined };
  }

  return {
    name: agentReference.slice(0, separator),
    version: agentReference.slice(separator + 1),
  };
}

function createFoundryClient({ endpoint, apiKey, agent, allowPreview }) {
  if (apiKey) {
    return {
      project: undefined,
      openAIClient: new OpenAI({
        apiKey: "unused",
        baseURL: `${endpoint}/openai/v1`,
        defaultHeaders: {
          "api-key": apiKey,
          Authorization: null,
        },
      }),
      authMode: "api key",
    };
  }

  const project = new AIProjectClient(endpoint, new DefaultAzureCredential());
  const agentName = parseAgentReference(agent).name;
  const openAIClient = allowPreview
    ? project.getOpenAIClient({
        azureConfig: {
          agentName,
          allowPreview: true,
        },
      })
    : project.getOpenAIClient();

  return { project, openAIClient, authMode: "Entra ID" };
}

async function createConversation(openAIClient, query) {
  return openAIClient.conversations.create({
    items: [{ type: "message", role: "user", content: query }],
  });
}

async function addUserMessage(openAIClient, conversationId, query) {
  await openAIClient.conversations.items.create(conversationId, {
    items: [{ type: "message", role: "user", content: query }],
  });
}

async function runSingleConversation({
  openAIClient,
  agentName,
  query,
  runs,
  timeoutMs,
  randomQuery,
  interRunDelayMs,
}) {
  let conversation;
  const results = [];

  try {
    for (let i = 1; i <= runs; i += 1) {
      const runQuery = queryForRun(query, i, randomQuery);
      if (!conversation) {
        conversation = await createConversation(openAIClient, runQuery);
      } else {
        await addUserMessage(openAIClient, conversation.id, runQuery);
      }

      results.push(await runOne(openAIClient, agentName, conversation.id, runQuery, i, timeoutMs));
      if (i < runs && interRunDelayMs > 0) {
        await delay(interRunDelayMs);
      }
    }
  } finally {
    if (conversation) {
      await deleteConversation(openAIClient, conversation.id);
    }
  }

  return results;
}

async function runFreshConversations({ openAIClient, agentName, query, runs, timeoutMs, randomQuery }) {
  const results = [];

  for (let i = 1; i <= runs; i += 1) {
    const runQuery = queryForRun(query, i, randomQuery);
    const conversation = await createConversation(openAIClient, runQuery);
    try {
      results.push(await runOne(openAIClient, agentName, conversation.id, runQuery, i, timeoutMs));
    } finally {
      await deleteConversation(openAIClient, conversation.id);
    }
  }

  return results;
}

async function runOne(openAIClient, agentName, conversationId, query, runNumber, timeoutMs) {
  console.log(`===== Run ${runNumber} ==========`);
  console.log(`     query: ${query}`);
  process.stdout.write("     stream: ");
  const result = await streamAgentResponse(openAIClient, agentName, conversationId, query, timeoutMs, {
    onToken: (token) => process.stdout.write(token),
  });
  process.stdout.write("\n");
  const status = result.ttftMs === undefined ? "no_first_token" : "ok";
  const ttft = result.ttftMs === undefined ? "n/a" : `${result.ttftMs.toFixed(1)} ms`;
  const ttlt = result.ttltMs === undefined ? "n/a" : `${result.ttltMs.toFixed(1)} ms`;
  console.log(
    `     ${status}, ttft=${ttft}, ttlt=${ttlt}, complete=${result.totalMs.toFixed(1)} ms`
  );
  console.log(`     response: ${result.response || "(empty)"}`);
  return { run: runNumber, status, query, ...result };
}

async function streamAgentResponse(
  openAIClient,
  agentName,
  conversationId,
  query,
  timeoutMs,
  { onToken = () => {} } = {}
) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let firstTokenMs;
  let lastTokenMs;
  let firstToken = "";
  const responseParts = [];
  let completedResponseText = "";

  try {
    const stream = await openAIClient.responses.create(
      {
        input: query,
        stream: true,
      },
      {
        body: {
          input: query,
          stream: true,
          conversation: conversationId,
          agent_reference: { name: agentName, type: "agent_reference" },
        },
        signal: controller.signal,
      }
    );

    for await (const event of stream) {
      const token = textDeltaFromEvent(event);
      if (token) {
        const tokenTimeMs = performance.now() - startedAt;
        if (firstTokenMs === undefined) {
          firstTokenMs = tokenTimeMs;
          firstToken = token;
        }
        lastTokenMs = tokenTimeMs;
        responseParts.push(token);
        onToken(token);
      }

      if (event.type === "response.completed") {
        completedResponseText = outputTextFromResponse(event.response);
      }

      if (event.type === "response.failed") {
        throw new Error(event.response?.error?.message ?? "Foundry agent response failed");
      }

      if (event.type === "error") {
        throw new Error(event.message ?? "Foundry agent stream returned an error event");
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for agent response`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (responseParts.length === 0 && completedResponseText) {
    firstTokenMs = performance.now() - startedAt;
    lastTokenMs = firstTokenMs;
    firstToken = completedResponseText;
    responseParts.push(completedResponseText);
    onToken(completedResponseText);
  }

  return {
    ttftMs: firstTokenMs,
    ttltMs: lastTokenMs,
    firstToken,
    totalMs: performance.now() - startedAt,
    response: responseParts.join("").trim(),
  };
}

function textDeltaFromEvent(event) {
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    return event.delta;
  }

  if (event.type === "response.text.delta" && typeof event.delta === "string") {
    return event.delta;
  }

  if (typeof event.delta === "string" && event.type?.includes("text") && event.type.endsWith(".delta")) {
    return event.delta;
  }

  return "";
}

function outputTextFromResponse(response) {
  if (!response) {
    return "";
  }

  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const parts = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

async function deleteConversation(openAIClient, conversationId) {
  try {
    await openAIClient.conversations.delete(conversationId);
  } catch (error) {
    console.warn(`Warning: failed to delete conversation ${conversationId}: ${error.message}`);
  }
}

function queryForRun(baseQuery, runNumber, randomQuery) {
  if (!randomQuery) {
    return baseQuery;
  }

  return `${baseQuery} Random cache-buster sentence ${runNumber}: ${randomSentence()}`;
}

function randomSentence() {
  const adjectives = ["amber", "brisk", "calm", "distant", "frosted", "gentle", "lively", "quiet"];
  const nouns = ["harbor", "lantern", "meadow", "notebook", "river", "signal", "window", "garden"];
  const verbs = ["carries", "frames", "guides", "holds", "mirrors", "paints", "shapes", "turns"];
  const objects = ["a silver idea", "the morning light", "a small question", "the blue horizon", "a curious pattern"];
  const pick = (items) => items[Math.floor(Math.random() * items.length)];
  const nonce = Math.random().toString(36).slice(2, 10);

  return `The ${pick(adjectives)} ${pick(nouns)} ${pick(verbs)} ${pick(objects)} near marker ${nonce}.`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) {
    return undefined;
  }
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function summarize(results) {
  const ttfts = results
    .map((item) => item.ttftMs)
    .filter((item) => item !== undefined)
    .sort((a, b) => a - b);
  const totals = results.map((item) => item.totalMs).sort((a, b) => a - b);
  const ttlts = results
    .map((item) => item.ttltMs)
    .filter((item) => item !== undefined)
    .sort((a, b) => a - b);
  const avg = (values) =>
    values.length === 0 ? undefined : values.reduce((sum, item) => sum + item, 0) / values.length;

  return {
    count: results.length,
    ttftCount: ttfts.length,
    ttftAvg: avg(ttfts),
    ttftMin: ttfts[0],
    ttftP50: percentile(ttfts, 50),
    ttftP95: percentile(ttfts, 95),
    ttftMax: ttfts[ttfts.length - 1],
    ttltAvg: avg(ttlts),
    ttltMin: ttlts[0],
    ttltP50: percentile(ttlts, 50),
    ttltP95: percentile(ttlts, 95),
    ttltMax: ttlts[ttlts.length - 1],
    totalAvg: avg(totals),
  };
}

function formatMs(value) {
  return value === undefined || Number.isNaN(value) ? "n/a" : `${value.toFixed(1)} ms`;
}

function writeCsv(path, results) {
  const rows = [
    "run,status,ttft_ms,ttlt_ms,total_ms,query,first_token,response",
    ...results.map((item) =>
      [
        item.run,
        item.status,
        item.ttftMs?.toFixed(3) ?? "",
        item.ttltMs?.toFixed(3) ?? "",
        item.totalMs.toFixed(3),
        csvEscape(item.query ?? ""),
        csvEscape(item.firstToken ?? ""),
        csvEscape(item.response ?? ""),
      ].join(",")
    ),
  ];
  writeFileSync(path, `${rows.join("\n")}\n`, "utf8");
}

function csvEscape(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!args.endpoint) {
    throw new Error("Missing --endpoint, FOUNDRY_PROJECT_ENDPOINT, or AZURE_EXISTING_AIPROJECT_ENDPOINT");
  }
  if (!args.agent) {
    throw new Error("Missing --agent, FOUNDRY_AGENT, or AZURE_EXISTING_AGENT_ID");
  }

  const { project, openAIClient, authMode } = createFoundryClient(args);
  const agent = project
    ? await resolveAgent(project, args.agent)
    : {
        name: parseAgentReference(args.agent).name,
        id: args.agent,
        version: parseAgentReference(args.agent).version,
      };
  console.log(
    `Agent: ${agent.name}` +
      (agent.id ? ` (${agent.id})` : "") +
      (agent.version ? ` version ${agent.version}` : "")
  );
  console.log(`Auth: ${authMode}`);
  console.log(`Runs: ${args.runs}; mode: ${args.reuseConversation ? "single conversation" : "fresh conversation per run"}`);

  const results = args.reuseConversation
    ? await runSingleConversation({
        openAIClient,
        agentName: agent.name,
        query: args.query,
        runs: args.runs,
        timeoutMs: args.timeoutMs,
        randomQuery: args.randomQuery,
        interRunDelayMs: args.interRunDelayMs,
      })
    : await runFreshConversations({
        openAIClient,
        agentName: agent.name,
        query: args.query,
        runs: args.runs,
        timeoutMs: args.timeoutMs,
        randomQuery: args.randomQuery,
      });

  const summary = summarize(results);
  console.log("\nSummary");
  console.log(`  Successful TTFT samples: ${summary.ttftCount}/${summary.count}`);
  console.log(`  TTFT avg/min/p50/p95/max: ${formatMs(summary.ttftAvg)} / ${formatMs(summary.ttftMin)} / ${formatMs(summary.ttftP50)} / ${formatMs(summary.ttftP95)} / ${formatMs(summary.ttftMax)}`);
  console.log(`  TTLT avg/min/p50/p95/max: ${formatMs(summary.ttltAvg)} / ${formatMs(summary.ttltMin)} / ${formatMs(summary.ttltP50)} / ${formatMs(summary.ttltP95)} / ${formatMs(summary.ttltMax)}`);
  console.log(`  Total response avg: ${formatMs(summary.totalAvg)}`);

  if (args.csv) {
    writeCsv(args.csv, results);
    console.log(`  CSV: ${args.csv}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
