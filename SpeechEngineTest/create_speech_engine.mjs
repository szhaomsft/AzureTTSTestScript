/**
 * Creates an ElevenLabs Speech Engine resource and enables first-message overrides.
 *
 * Usage:
 *   node create_speech_engine.mjs <ELEVENLABS_API_KEY> <PUBLIC_WS_URL>
 *
 * Example:
 *   node create_speech_engine.mjs sk-... wss://abc123.trycloudflare.com/speech-engine/ws
 */

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const apiKey = process.argv[2]?.trim();
const publicWsUrl = process.argv[3]?.trim();

if (!apiKey || !publicWsUrl) {
  console.error("Usage: node create_speech_engine.mjs <ELEVENLABS_API_KEY> <PUBLIC_WS_URL>");
  console.error("Example: node create_speech_engine.mjs sk-... wss://abc123.trycloudflare.com/speech-engine/ws");
  process.exit(1);
}

const elevenlabs = new ElevenLabsClient({ apiKey });

console.log("Creating Speech Engine...");
console.log(`  WS URL: ${publicWsUrl}`);

const engine = await elevenlabs.speechEngine.create({
  name: "Speech Engine Test",
  speechEngine: {
    wsUrl: publicWsUrl,
  },
  turn: {
    turnTimeout: 30,
    silenceEndCallTimeout: 120,
  },
  conversation: {
    maxDurationSeconds: 3600,
  },
});

console.log(`Speech Engine created: ${engine.engineId}`);

console.log("Enabling first-message override...");
await elevenlabs.speechEngine.update(engine.engineId, {
  overrides: {
    firstMessage: true,
  },
});

console.log("Done!");
console.log("");
console.log("============================================");
console.log(`  Speech Engine ID : ${engine.engineId}`);
console.log("============================================");
console.log("");
console.log("Paste this ID into the Speech Engine Test UI.");
