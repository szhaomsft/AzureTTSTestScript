import http from "node:http";
import { URL } from "node:url";

import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";

const port = Number.parseInt(process.env.PORT ?? "5174", 10);

const vite = await createViteServer({
  server: { middlewareMode: true, allowedHosts: true },
  appType: "spa",
});

const server = http.createServer((req, res) => {
  vite.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end("Not found");
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (requestUrl.pathname === "/voice-live/realtime") {
    wss.handleUpgrade(req, socket, head, (clientSocket) => {
      proxyVoiceLiveWebSocket(clientSocket, requestUrl);
    });
    return;
  }
  socket.destroy();
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
