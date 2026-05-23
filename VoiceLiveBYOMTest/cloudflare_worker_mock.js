const DEFAULT_MODEL = "cloudflare-worker-no-auth-chat-completion";
const STREAM_CHUNK_DELAY_MS = 50;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && isHealthPath(url.pathname)) {
      return jsonResponse({ status: "ok" });
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
