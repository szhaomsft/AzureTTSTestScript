// App server — Vite dev server + GET /api/token endpoint.
// Mirrors the quickstart's Next.js route handler.

import { createServer as createViteServer } from "vite";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import "dotenv/config";

const API_KEY = process.env.ELEVENLABS_API_KEY?.trim();
const SPEECH_ENGINE_ID = process.env.ELEVENLABS_SPEECH_ENGINE_ID?.trim();
const PORT = parseInt(process.env.APP_PORT || "5175", 10);

if (!API_KEY) {
  throw new Error("Missing ELEVENLABS_API_KEY in .env");
}
if (!SPEECH_ENGINE_ID) {
  throw new Error("Missing ELEVENLABS_SPEECH_ENGINE_ID in .env");
}

const elevenlabs = new ElevenLabsClient({ apiKey: API_KEY });

const apiMiddleware = async (req, res, next) => {
  if (req.method === "GET" && req.url === "/api/token") {
    try {
      const response =
        await elevenlabs.conversationalAi.conversations.getWebrtcToken({
          agentId: SPEECH_ENGINE_ID,
        });

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ token: response.token }));
    } catch (error) {
      const details =
        error instanceof Error ? error.message : "Failed to create a token.";

      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Unable to create a conversation token.",
          details,
        })
      );
    }
    return;
  }
  next();
};

const vite = await createViteServer({
  server: { port: PORT, strictPort: true },
  appType: "spa",
  plugins: [
    {
      name: "api-middleware",
      configureServer(server) {
        // Register before Vite's internal middleware
        server.middlewares.use(apiMiddleware);
      },
    },
  ],
});

await vite.listen();
console.log(`App server listening on http://localhost:${PORT}`);
