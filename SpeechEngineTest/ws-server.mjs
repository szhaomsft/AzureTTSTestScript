// Speech Engine WebSocket server — mirrors the quickstart example's server.mts.
// Run on port 3001, expose via tunnel (ngrok/cloudflare).

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createServer } from "node:http";
import "dotenv/config";

const API_KEY = process.env.ELEVENLABS_API_KEY?.trim();
const SPEECH_ENGINE_ID = process.env.ELEVENLABS_SPEECH_ENGINE_ID?.trim();

if (!API_KEY) {
  throw new Error("Missing ELEVENLABS_API_KEY in .env");
}

if (!SPEECH_ENGINE_ID) {
  throw new Error("Missing ELEVENLABS_SPEECH_ENGINE_ID in .env");
}

const elevenlabs = new ElevenLabsClient({
  apiKey: API_KEY,
});

const httpServer = createServer();

// Track raw WebSocket connections to diagnose tunnel drops
httpServer.on("upgrade", (req, socket) => {
  socket.on("close", (hadError) => {
    console.log(`[DEBUG] Raw socket closed (hadError=${hadError}, url=${req.url})`);
  });
  socket.on("error", (err) => {
    console.log(`[DEBUG] Raw socket error: ${err.message}`);
  });
});

elevenlabs.speechEngine.attach(SPEECH_ENGINE_ID, httpServer, "/ws", {
  debug: true,

  onInit(conversationId) {
    console.log("Speech Engine session started:", conversationId);
  },

  async onTranscript(transcript, signal, session) {
    console.log("Transcript:", JSON.stringify(transcript));

    const echoStream = createEchoStream(transcript);
    session.sendResponse(echoStream);
  },

  onClose(session) {
    console.log("Speech Engine session closed:", session.conversationId);
  },

  onError(error) {
    console.error("Speech Engine error:", error);
  },
});

httpServer.listen(3001, () => {
  console.log("Speech Engine server listening on http://localhost:3001");
});

function createEchoStream(transcript) {
  const lastUserMessage = findLastUserTranscript(transcript);
  const reply = lastUserMessage
    ? `You said: ${lastUserMessage}`
    : "I didn't catch anything. Could you say that again?";
  const words = reply.split(" ");
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < words.length; i++) {
        yield (i === 0 ? "" : " ") + words[i];
      }
    },
  };
}

function findLastUserTranscript(transcript) {
  if (!Array.isArray(transcript)) {
    return "";
  }
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === "user" && transcript[i].content) {
      return String(transcript[i].content).trim();
    }
  }
  return "";
}
