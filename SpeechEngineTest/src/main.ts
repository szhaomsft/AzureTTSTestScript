// Client — mirrors the quickstart example's page.tsx using @elevenlabs/client directly.

import { Conversation } from "@elevenlabs/client";

import "./style.css";

let conversation: Conversation | undefined;

const startButton = getElement<HTMLButtonElement>("start");
const stopButton = getElement<HTMLButtonElement>("stop");
const transcriptOutput = getElement<HTMLPreElement>("transcript-output");
const logOutput = getElement<HTMLPreElement>("log-output");

startButton.addEventListener("click", () => {
  startConversation().catch((error: unknown) => logError("Start failed", error));
});

stopButton.addEventListener("click", () => {
  stopConversation().catch((error: unknown) => logError("Stop failed", error));
});

// Mirrors getConversationToken() in the example
async function getConversationToken(): Promise<string> {
  const response = await fetch("/api/token");
  const data = (await response.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
    details?: string;
  };

  if (!response.ok || !data.token) {
    throw new Error(data.details || data.error || "Failed to get a conversation token.");
  }

  return data.token;
}

// Mirrors startVoiceMode() in the example
async function startConversation(): Promise<void> {
  if (conversation) {
    log("Conversation already active.");
    return;
  }

  // Request mic permission first, like the example does
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not available in this browser.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());

  log("Requesting conversation token...");
  const token = await getConversationToken();
  log("Token received. Starting WebRTC session...");

  transcriptOutput.textContent = "";

  const firstMessage = getInputValue("first-message");

  conversation = await Conversation.startSession({
    conversationToken: token,
    overrides: firstMessage
      ? { agent: { firstMessage } }
      : undefined,
    onConnect: ({ conversationId }) => {
      log(`Connected. Conversation ID: ${conversationId}`);
      startButton.disabled = true;
      stopButton.disabled = false;
    },
    onDisconnect: (details) => {
      log(`Disconnected: ${JSON.stringify(details)}`);
      conversation = undefined;
      startButton.disabled = false;
      stopButton.disabled = true;
    },
    onError: (message, context) => {
      log(`Error: ${message}${context ? ` (${JSON.stringify(context)})` : ""}`);
    },
    onMessage: ({ source, message }) => {
      const label = source === "ai" ? "assistant" : "user";
      const content = message.trim();
      if (content) {
        appendTranscript(`${label}: ${content}`);
      }
    },
    onModeChange: ({ mode }) => {
      log(`Mode: ${mode}`);
    },
  });
}

// Mirrors stopVoiceMode() in the example
async function stopConversation(): Promise<void> {
  if (!conversation) {
    return;
  }
  await conversation.endSession();
  conversation = undefined;
  startButton.disabled = false;
  stopButton.disabled = true;
  log("Conversation ended.");
}

// --- UI helpers ---

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

function getInputValue(id: string): string {
  const element = getElement<HTMLInputElement | HTMLTextAreaElement>(id);
  return element.value.trim();
}

function appendTranscript(text: string): void {
  transcriptOutput.textContent += `${text}\n`;
  transcriptOutput.scrollTop = transcriptOutput.scrollHeight;
}

function log(message: string): void {
  logOutput.textContent += `[${new Date().toISOString()}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function logError(message: string, error: unknown): void {
  log(`${message}: ${formatError(error)}`);
  console.error(message, error);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "[object Object]" ? error.name : `${error.name}: ${error.message}`;
  }
  if (error instanceof Event) {
    return `${error.type} event (check browser console for details)`;
  }
  return JSON.stringify(error);
}
