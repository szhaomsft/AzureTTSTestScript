import http from "node:http";
import { URL } from "node:url";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";

const port = Number.parseInt(process.env.PORT ?? "5174", 10);
const speechEnginePath = "/speech-engine/ws";
const speechEngineConfig = {
  apiKey: "",
  speechEngineId: "",
  byomEndpoint: "",
  model: "",
  instructions: "",
};
let attachedSpeechEngineId = "";

const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "spa",
});

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/speech-engine/configure") {
    handleSpeechEngineConfigure(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/speech-engine/token") {
    handleSpeechEngineToken(req, res);
    return;
  }

  vite.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end("Not found");
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (requestUrl.pathname !== "/voice-live/realtime") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (clientSocket) => {
    proxyVoiceLiveWebSocket(clientSocket, requestUrl);
  });
});

function buildUpstreamUrl(requestUrl) {
  const target = requestUrl.searchParams.get("voice-live-target");
  if (!target) {
    throw new Error("Missing voice-live-target query parameter.");
  }

  const upstreamUrl = new URL(target);
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  upstreamUrl.pathname = "/voice-live/realtime";
  upstreamUrl.search = "";

  for (const [key, value] of requestUrl.searchParams.entries()) {
    if (key === "voice-live-target" || key === "byom-endpoint") {
      continue;
    }
    upstreamUrl.searchParams.append(key, value);
  }

  return upstreamUrl;
}

function proxyVoiceLiveWebSocket(clientSocket, requestUrl) {
  const byomEndpoint = requestUrl.searchParams.get("byom-endpoint");
  if (!byomEndpoint) {
    clientSocket.close(1008, "Missing byom-endpoint query parameter.");
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = buildUpstreamUrl(requestUrl);
  } catch (error) {
    clientSocket.close(1008, error instanceof Error ? error.message : "Invalid upstream URL.");
    return;
  }

  console.log(`[proxy] ${upstreamUrl.host}${upstreamUrl.pathname} -> BYOM ${byomEndpoint}`);
  const upstreamSocket = new WebSocket(upstreamUrl, {
    headers: {
      "byom-endpoint": byomEndpoint,
    },
    perMessageDeflate: false,
  });

  const pendingMessages = [];

  clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
      return;
    }
    pendingMessages.push({ data, isBinary });
  });

  upstreamSocket.on("open", () => {
    for (const message of pendingMessages.splice(0)) {
      upstreamSocket.send(message.data, { binary: message.isBinary });
    }
  });

  upstreamSocket.on("message", (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary });
    }
  });

  upstreamSocket.on("close", (code, reason) => {
    if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
      clientSocket.close(code, reason.toString());
    }
  });

  clientSocket.on("close", (code, reason) => {
    if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) {
      upstreamSocket.close(code, reason.toString());
    }
  });

  upstreamSocket.on("error", (error) => {
    console.error("[proxy] upstream WebSocket error", error);
    if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
      clientSocket.close(1011, "Upstream Voice Live WebSocket error.");
    }
  });

  clientSocket.on("error", (error) => {
    console.error("[proxy] browser WebSocket error", error);
  });
}

async function handleSpeechEngineConfigure(req, res) {
  try {
    const body = await readJsonBody(req);
    updateSpeechEngineConfig(body);
    attachSpeechEngineIfNeeded();
    sendJson(res, 200, { status: "ok", wsPath: speechEnginePath });
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid Speech Engine config." });
  }
}

async function handleSpeechEngineToken(req, res) {
  try {
    const body = await readJsonBody(req);
    const apiKey = String(body.apiKey || speechEngineConfig.apiKey || "").trim();
    const speechEngineId = String(body.speechEngineId || speechEngineConfig.speechEngineId || "").trim();
    if (!apiKey || !speechEngineId) {
      throw new Error("apiKey and speechEngineId are required.");
    }

    const elevenlabs = new ElevenLabsClient({ apiKey });
    const tokenResponse = await elevenlabs.conversationalAi.conversations.getWebrtcToken({
      agentId: speechEngineId,
    });
    sendJson(res, 200, { token: tokenResponse.token });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to create Speech Engine token." });
  }
}

function updateSpeechEngineConfig(body) {
  speechEngineConfig.apiKey = String(body.apiKey || "").trim();
  speechEngineConfig.speechEngineId = String(body.speechEngineId || "").trim();
  speechEngineConfig.byomEndpoint = String(body.byomEndpoint || "").trim();
  speechEngineConfig.model = String(body.model || "").trim();
  speechEngineConfig.instructions = String(body.instructions || "").trim();
  if (!speechEngineConfig.apiKey || !speechEngineConfig.speechEngineId || !speechEngineConfig.byomEndpoint) {
    throw new Error("apiKey, speechEngineId, and byomEndpoint are required.");
  }
}

function attachSpeechEngineIfNeeded() {
  if (attachedSpeechEngineId === speechEngineConfig.speechEngineId) {
    return;
  }

  const elevenlabs = new ElevenLabsClient({ apiKey: speechEngineConfig.apiKey });
  elevenlabs.speechEngine.attach(speechEngineConfig.speechEngineId, server, speechEnginePath, {
    debug: true,
    onInit(conversationId) {
      console.log(`[speech-engine] session started ${conversationId}`);
    },
    async onTranscript(transcript, signal, session) {
      console.log("[speech-engine] transcript", JSON.stringify(transcript));
      const responseStream = await createMockChatStream(transcript, signal);
      session.sendResponse(responseStream);
    },
    onClose(session) {
      console.log(`[speech-engine] session closed ${session.conversationId || ""}`);
    },
    onError(error) {
      console.error("[speech-engine] error", error);
    },
  });
  attachedSpeechEngineId = speechEngineConfig.speechEngineId;
  console.log(`[speech-engine] attached ${attachedSpeechEngineId} at ${speechEnginePath}`);
}

async function createMockChatStream(transcript, signal) {
  const messages = transcriptToMessages(transcript);
  const response = await fetch(getChatCompletionsUrl(speechEngineConfig.byomEndpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: speechEngineConfig.model || "gpt-4.1",
      stream: true,
      messages: [{ role: "system", content: speechEngineConfig.instructions }, ...messages],
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Mock chat completion failed: ${response.status} ${await response.text()}`);
  }
  return response.body ? streamSseTextDeltas(response.body) : streamSingleText(await response.text());
}

function transcriptToMessages(transcript) {
  if (!Array.isArray(transcript)) {
    return [];
  }
  return transcript
    .map((message) => ({
      role: message.role === "agent" ? "assistant" : "user",
      content: String(message.content || "").trim(),
    }))
    .filter((message) => message.content);
}

function streamSseTextDeltas(body) {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const delta = parseSseTextDelta(part);
          if (delta) {
            yield delta;
          }
        }
      }
    },
  };
}

function parseSseTextDelta(part) {
  const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) {
    return "";
  }
  const data = dataLine.slice("data:".length).trim();
  if (!data || data === "[DONE]") {
    return "";
  }
  try {
    const payload = JSON.parse(data);
    return payload.choices?.[0]?.delta?.content || "";
  } catch {
    return "";
  }
}

function streamSingleText(text) {
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

function getChatCompletionsUrl(baseEndpoint) {
  const url = new URL(baseEndpoint);
  const path = url.pathname.replace(/\/$/, "");
  if (path.endsWith("/chat/completions")) {
    return url.toString();
  }
  url.pathname = `${path}/chat/completions`;
  return url.toString();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

server.listen(port, () => {
  console.log(`VoiceLiveBYOMTest running at http://localhost:${port}`);
});
