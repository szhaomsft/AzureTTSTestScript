const DEFAULT_MODEL = "cloudflare-worker-no-auth-chat-completion";
const STREAM_CHUNK_DELAY_MS = 50;
const SPEECH_ENGINE_WS_PATH = "/speech-engine/ws";
const WEBSOCKET_NORMAL_CLOSURE = 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (url.pathname === SPEECH_ENGINE_WS_PATH) {
        return handleSpeechEngineWebSocket();
      }
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && isHealthPath(url.pathname)) {
      return jsonResponse({ status: "ok" });
    }

    if (request.method === "POST" && url.pathname === "/speech-engine/token") {
      return handleSpeechEngineToken(request);
    }

    if (request.method !== "POST" || !isChatCompletionPath(url.pathname)) {
      return jsonResponse({ error: { message: "Not found" } }, 404);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: { message: "Request body must be valid JSON" } }, 400);
    }

    const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    const content = buildResponseText(body);

    console.log(
      JSON.stringify({
        event: "chat.completions",
        model,
        stream: Boolean(body.stream),
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        lastUser: findLastUserMessage(body.messages),
        response: content,
      }),
    );

    if (body.stream) {
      return streamResponse(model, content);
    }

    return jsonResponse(buildCompletionResponse(model, content));
  },
};

async function handleSpeechEngineToken(request) {
  const startedAt = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: { message: "Request body must be valid JSON" } }, 400);
  }

  const apiKey = String(body.apiKey || "").trim();
  const speechEngineId = String(body.speechEngineId || "").trim();
  console.log(JSON.stringify({ event: "speech_engine.token.start", speechEngineId }));
  if (!apiKey || !speechEngineId) {
    return jsonResponse({ error: { message: "apiKey and speechEngineId are required" } }, 400);
  }

  const tokenUrl = new URL("https://api.elevenlabs.io/v1/convai/conversation/token");
  tokenUrl.searchParams.set("agent_id", speechEngineId);
  const tokenResponse = await fetch(tokenUrl, {
    method: "GET",
    headers: { "xi-api-key": apiKey },
  });

  const responseText = await tokenResponse.text();
  console.log(
    JSON.stringify({
      event: "speech_engine.token.end",
      speechEngineId,
      status: tokenResponse.status,
      durationMs: Date.now() - startedAt,
    }),
  );
  if (!tokenResponse.ok) {
    return jsonResponse({ error: { message: responseText || "Failed to get Speech Engine token" } }, tokenResponse.status);
  }

  return new Response(responseText, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": tokenResponse.headers.get("Content-Type") || "application/json; charset=utf-8",
    },
  });
}

function handleSpeechEngineWebSocket() {
  const acceptedAt = Date.now();
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  let activeGeneration = 0;
  let conversationId = "";

  server.accept();
  console.log(JSON.stringify({ event: "speech_engine.websocket.accepted" }));
  server.addEventListener("message", (event) => {
    void handleSpeechEngineMessage(server, event.data, {
      acceptedAt,
      get activeGeneration() {
        return activeGeneration;
      },
      nextGeneration() {
        activeGeneration += 1;
        return activeGeneration;
      },
      get conversationId() {
        return conversationId;
      },
      set conversationId(value) {
        conversationId = value;
      },
    });
  });
  server.addEventListener("close", () => {
    console.log(JSON.stringify({ event: "speech_engine.closed", conversationId }));
  });
  server.addEventListener("error", (event) => {
    console.log(JSON.stringify({ event: "speech_engine.error", conversationId, error: String(event.error ?? event) }));
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleSpeechEngineMessage(ws, rawMessage, state) {
  let message;
  try {
    message = JSON.parse(await decodeWebSocketMessage(rawMessage));
  } catch {
    sendSpeechEngineError(ws, "Invalid JSON message.");
    return;
  }

  if (message.type === "init") {
    state.conversationId = String(message.conversation_id || "");
    console.log(JSON.stringify({ event: "speech_engine.init", conversationId: state.conversationId, sinceAcceptedMs: Date.now() - state.acceptedAt }));
    return;
  }

  if (message.type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
    return;
  }

  if (message.type === "close") {
    ws.close(WEBSOCKET_NORMAL_CLOSURE, "Speech Engine requested close.");
    return;
  }

  if (message.type === "error") {
    console.log(JSON.stringify({ event: "speech_engine.remote_error", message: message.message }));
    return;
  }

  if (message.type !== "user_transcript") {
    console.log(JSON.stringify({ event: "speech_engine.ignored_message", type: message.type }));
    return;
  }

  const generation = state.nextGeneration();
  const transcript = Array.isArray(message.user_transcript) ? message.user_transcript : [];
  const responseContent = buildSpeechEngineResponseText(transcript);
  console.log(
    JSON.stringify({
      event: "speech_engine.transcript",
      conversationId: state.conversationId,
      eventId: message.event_id,
      transcript,
      response: responseContent,
    }),
  );

  await sendSpeechEngineResponseStream(ws, responseContent, message.event_id, generation, state);
}

async function decodeWebSocketMessage(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

function buildSpeechEngineResponseText(transcript) {
  const messages = transcript.map((message) => ({
    role: message.role === "agent" ? "assistant" : "user",
    content: String(message.content || ""),
  }));
  return buildResponseText({ messages });
}

async function sendSpeechEngineResponseStream(ws, content, eventId, generation, state) {
  for (const chunk of splitStreamChunks(content)) {
    if (generation !== state.activeGeneration) {
      return;
    }
    ws.send(JSON.stringify({ type: "agent_response", content: chunk, event_id: eventId, is_final: false }));
    await sleep(STREAM_CHUNK_DELAY_MS);
  }
  if (generation === state.activeGeneration) {
    ws.send(JSON.stringify({ type: "agent_response", content: "", event_id: eventId, is_final: true }));
  }
}

function sendSpeechEngineError(ws, message) {
  console.log(JSON.stringify({ event: "speech_engine.local_error", message }));
  ws.send(JSON.stringify({ type: "error", message }));
}

function isHealthPath(pathname) {
  return pathname === "/" || pathname === "/health";
}

function isChatCompletionPath(pathname) {
  const path = pathname.replace(/\/$/, "");
  return path === "/chat/completions" || path === "/v1/chat/completions" || path === "/openai/v1/chat/completions";
}

function buildResponseText(body) {
  const lastUserMessage = findLastUserMessage(body.messages);
  if (!lastUserMessage) {
    return "Hello from the Cloudflare Worker no-auth BYOM chat completion API.";
  }
  return `Cloudflare BYOM API received: ${lastUserMessage}`;
}

function findLastUserMessage(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join(" ");
    }
  }
  return "";
}

function buildCompletionResponse(model, content) {
  return {
    id: `chatcmpl-worker-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

function streamResponse(model, content) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of splitStreamChunks(content)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(buildStreamChunk(model, chunk, null))}\n\n`));
        await sleep(STREAM_CHUNK_DELAY_MS);
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(buildStreamChunk(model, "", "stop"))}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

function buildStreamChunk(model, content, finishReason) {
  return {
    id: `chatcmpl-worker-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  };
}

function splitStreamChunks(content) {
  const words = content.split(/\s+/).filter(Boolean);
  return words.length > 0 ? words.map((word) => `${word} `) : [""];
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
