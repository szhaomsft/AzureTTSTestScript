#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const DEFAULT_API_BASE = "https://api.elevenlabs.io";
const DEFAULT_RUNS = 100;
const DEFAULT_QUERY = "Hello, please answer with one short sentence.";
const DEFAULT_TIMEOUT_MS = 60000;

loadEnvFile();

function loadEnvFile(path = ".env") {
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
  npm run latency -- --api-key <key> --agent <agent-name-or-id> [options]

Options:
  --api-key <key>       ElevenLabs API key. Defaults to ELEVENLABS_API_KEY.
  --agent <name-or-id>  Agent name or agent_id. Defaults to ELEVENLABS_AGENT.
  --query <text>        Text query to send. Default: "${DEFAULT_QUERY}"
  --runs <n>            Number of test runs. Default: ${DEFAULT_RUNS}
  --timeout-ms <n>      Timeout per run. Default: ${DEFAULT_TIMEOUT_MS}
  --api-base <url>      ElevenLabs API base URL. Default: ${DEFAULT_API_BASE}
  --csv <path>          Write per-run results to a CSV file.
  --random-query        Append a unique random sentence to each query to avoid cache.
  --reuse-session       Send all queries in one conversation instead of opening one per run.
  --no-text-override    Do not request text-only mode at conversation start.
  --help                Show this help.

Examples:
  npm run latency -- --agent "Support Bot" --query "What can you do?"
  $env:ELEVENLABS_API_KEY="..." ; npm run latency -- --agent agent_abc123 --runs 100
`);
}

function parseArgs(argv) {
  const args = {
    apiKey: process.env.ELEVENLABS_API_KEY,
    agent: process.env.ELEVENLABS_AGENT,
    query: DEFAULT_QUERY,
    runs: DEFAULT_RUNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    apiBase: DEFAULT_API_BASE,
    csv: undefined,
    randomQuery: false,
    reuseSession: false,
    textOverride: true,
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
      case "--api-base":
        args.apiBase = readValue().replace(/\/+$/, "");
        break;
      case "--csv":
        args.csv = readValue();
        break;
      case "--random-query":
        args.randomQuery = true;
        break;
      case "--reuse-session":
        args.reuseSession = true;
        break;
      case "--no-text-override":
        args.textOverride = false;
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

async function fetchJson(url, { apiKey }) {
  const response = await fetch(url, {
    headers: {
      "xi-api-key": apiKey,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ElevenLabs API ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

function looksLikeAgentId(value) {
  return /^agent_[A-Za-z0-9]+/.test(value);
}

async function resolveAgentId({ apiBase, apiKey, agent }) {
  if (looksLikeAgentId(agent)) {
    return { id: agent, name: agent };
  }

  const params = new URLSearchParams({
    search: agent,
    page_size: "100",
    archived: "false",
  });
  const data = await fetchJson(`${apiBase}/v1/convai/agents?${params}`, { apiKey });
  const matches = (data.agents ?? []).filter((item) => item.name === agent);

  if (matches.length === 1) {
    return { id: matches[0].agent_id, name: matches[0].name };
  }

  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} agents named "${agent}". Pass the agent_id instead.`);
  }

  const suggestions = (data.agents ?? []).map((item) => item.name).slice(0, 10);
  throw new Error(
    `No agent named "${agent}" found.` +
      (suggestions.length ? ` Search returned: ${suggestions.join(", ")}` : "")
  );
}

async function getSignedUrl({ apiBase, apiKey, agentId }) {
  const params = new URLSearchParams({ agent_id: agentId });
  const data = await fetchJson(`${apiBase}/v1/convai/conversation/get-signed-url?${params}`, {
    apiKey,
  });
  if (!data.signed_url) {
    throw new Error("Signed URL response did not include signed_url");
  }
  return data.signed_url;
}

function createConversation({ signedUrl, textOverride, timeoutMs }) {
  const ws = new WebSocket(signedUrl);
  let closed = false;

  const pending = new Set();
  const close = () => {
    closed = true;
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(new Error("WebSocket closed before the run completed"));
    }
    pending.clear();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket connection"));
      close();
    }, timeoutMs);

    ws.once("open", () => {
      clearTimeout(timeout);
      sendJson(ws, {
        type: "conversation_initiation_client_data",
        ...(textOverride
          ? {
              conversation_config_override: {
                agent: { first_message: "" },
                conversation: { text_only: true },
              },
            }
          : {}),
      });
      resolve();
    });

    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "ping") {
      const delay = message.ping_event?.ping_ms ?? 0;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          sendJson(ws, { type: "pong", event_id: message.ping_event?.event_id });
        }
      }, delay);
      return;
    }

    if (message.type === "client_tool_call") {
      const toolCallId = message.client_tool_call?.tool_call_id;
      if (toolCallId) {
        sendJson(ws, {
          type: "client_tool_result",
          tool_call_id: toolCallId,
          result: "Client tool execution is not available in this latency test.",
          is_error: true,
        });
      }
      return;
    }

    const current = firstPending(pending);
    if (!current || current.completed) {
      return;
    }

    const finalText = finalResponseText(message, current.responseParts.length > 0);
    if (finalText) {
      const tokenTimeMs = performance.now() - current.sentAt;
      if (current.firstTokenMs === undefined) {
        current.firstTokenMs = tokenTimeMs;
        current.firstToken = finalText;
      }
      current.lastTokenMs = tokenTimeMs;
      current.responseParts.push(finalText);
      current.onToken(finalText);
    }

    if (isResponseComplete(message) || message.type === "agent_response") {
      current.completed = true;
      clearTimeout(current.timeout);
      pending.delete(current);
      current.resolve({
        ttftMs: current.firstTokenMs,
        ttltMs: current.lastTokenMs,
        firstToken: current.firstToken,
        totalMs: performance.now() - current.sentAt,
        response: current.responseParts.join("").trim(),
      });
    }
  });

  ws.on("close", () => {
    if (!closed) {
      close();
    }
  });

  ws.on("error", (error) => {
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(error);
    }
    pending.clear();
  });

  async function sendUserMessage(text, { onToken = () => {} } = {}) {
    await ready;
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }

    return new Promise((resolve, reject) => {
      const request = {
        sentAt: performance.now(),
        firstTokenMs: undefined,
        lastTokenMs: undefined,
        firstToken: "",
        responseParts: [],
        onToken,
        completed: false,
        resolve,
        reject,
        timeout: setTimeout(() => {
          pending.delete(request);
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for agent response`));
        }, timeoutMs),
      };

      pending.add(request);
      sendJson(ws, { type: "user_message", text });
    });
  }

  return { ready, sendUserMessage, close };
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function firstPending(pending) {
  return pending.values().next().value;
}

function finalResponseText(message, alreadyReceivedDeltas) {
  if (message.type === "agent_chat_response_part") {
    const part = message.text_response_part;
    return part?.type === "delta" ? part.text ?? "" : "";
  }

  if (message.type === "agent_response") {
    return alreadyReceivedDeltas ? "" : message.agent_response_event?.agent_response ?? "";
  }

  return "";
}

function isResponseComplete(message) {
  return (
    message.type === "agent_response_complete" ||
    (message.type === "agent_chat_response_part" && message.text_response_part?.type === "stop")
  );
}

async function runSingleConversation({ signedUrl, query, runs, timeoutMs, textOverride, randomQuery }) {
  const conversation = createConversation({ signedUrl, timeoutMs, textOverride });
  await conversation.ready;

  try {
    const results = [];
    for (let i = 1; i <= runs; i += 1) {
      results.push(await runOne(conversation, queryForRun(query, i, randomQuery), i));
    }
    return results;
  } finally {
    conversation.close();
  }
}

async function runFreshConversations({ apiBase, apiKey, agentId, query, runs, timeoutMs, textOverride, randomQuery }) {
  const results = [];
  for (let i = 1; i <= runs; i += 1) {
    const signedUrl = await getSignedUrl({ apiBase, apiKey, agentId });
    const conversation = createConversation({ signedUrl, timeoutMs, textOverride });
    await conversation.ready;
    try {
      results.push(await runOne(conversation, queryForRun(query, i, randomQuery), i));
    } finally {
      conversation.close();
    }
  }
  return results;
}

async function runOne(conversation, query, runNumber) {
  console.log(`===== Run ${runNumber} ==========`);
  console.log(`     query: ${query}`);
  process.stdout.write("     stream: ");
  const result = await conversation.sendUserMessage(query, {
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
  const avg = (values) => values.reduce((sum, item) => sum + item, 0) / values.length;

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

  if (!args.apiKey) {
    throw new Error("Missing --api-key or ELEVENLABS_API_KEY");
  }
  if (!args.agent) {
    throw new Error("Missing --agent or ELEVENLABS_AGENT");
  }

  const agent = await resolveAgentId(args);
  console.log(`Agent: ${agent.name} (${agent.id})`);
  console.log(`Runs: ${args.runs}; mode: ${args.reuseSession ? "single conversation" : "fresh conversation per run"}`);

  const results = args.reuseSession
    ? await runSingleConversation({
        signedUrl: await getSignedUrl({ ...args, agentId: agent.id }),
        query: args.query,
        runs: args.runs,
        timeoutMs: args.timeoutMs,
        textOverride: args.textOverride,
        randomQuery: args.randomQuery,
      })
    : await runFreshConversations({
        ...args,
        agentId: agent.id,
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
