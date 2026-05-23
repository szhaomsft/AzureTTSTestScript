import {
  VoiceLiveClient,
  type ServerEventResponseTextDelta,
  type ServerEventResponseAudioDelta,
  type UserMessageItem,
  type VoiceLiveSession,
} from "@azure/ai-voicelive";
import { AzureKeyCredential } from "@azure/core-auth";

import "./style.css";

let session: VoiceLiveSession | undefined;
let responseText = "";
let audioContext: AudioContext | undefined;
let mediaStream: MediaStream | undefined;
let mediaSource: MediaStreamAudioSourceNode | undefined;
let audioProcessor: ScriptProcessorNode | undefined;
let playbackAudioContext: AudioContext | undefined;
let nextPlaybackTime = 0;
let playbackStartLogged = false;
const activePlaybackSources = new Set<AudioBufferSourceNode>();

// localStorage key for BYOM test form settings restored across browser reloads.
const CONFIG_STORAGE_KEY = "voice-live-byom-test-config";
// Voice Live expects PCM16 microphone chunks at 24 kHz for this test session.
const TARGET_SAMPLE_RATE = 24_000;
// Voice Live returns PCM16 audio at 24 kHz for this test session.
const OUTPUT_SAMPLE_RATE = 24_000;
// Browser ScriptProcessor buffer size used to batch microphone samples before resampling.
const AUDIO_PROCESSOR_BUFFER_SIZE = 4096;
// Clamp threshold for Float32 microphone samples before PCM16 conversion.
const PCM_SAMPLE_LIMIT = 1;

const CONFIG_FIELD_IDS = [
  "voice-live-endpoint",
  "voice-live-api-key",
  "byom-endpoint",
  "model",
  "instructions",
  "message",
] as const;

type ConfigFieldId = (typeof CONFIG_FIELD_IDS)[number];
type SavedConfig = Partial<Record<ConfigFieldId, string>>;

const connectButton = getElement<HTMLButtonElement>("connect");
const sendButton = getElement<HTMLButtonElement>("send");
const disconnectButton = getElement<HTMLButtonElement>("disconnect");
const clearSavedConfigButton = getElement<HTMLButtonElement>("clear-saved-config");
const responseOutput = getElement<HTMLPreElement>("response");
const logOutput = getElement<HTMLPreElement>("log");

restoreSavedConfig();
setupConfigPersistence();

connectButton.addEventListener("click", () => {
  connect().catch((error: unknown) => logError("Connect failed", error));
});

sendButton.addEventListener("click", () => {
  sendText().catch((error: unknown) => logError("Send failed", error));
});

disconnectButton.addEventListener("click", () => {
  disconnect().catch((error: unknown) => logError("Disconnect failed", error));
});

clearSavedConfigButton.addEventListener("click", () => {
  localStorage.removeItem(CONFIG_STORAGE_KEY);
  log("Saved config cleared.");
});

async function connect(): Promise<void> {
  const voiceLiveEndpoint = getInputValue("voice-live-endpoint");
  const voiceLiveApiKey = getInputValue("voice-live-api-key");
  const byomEndpoint = getInputValue("byom-endpoint");
  const model = getInputValue("model");

  if (!voiceLiveEndpoint || !voiceLiveApiKey || !byomEndpoint || !model) {
    throw new Error("Voice Live endpoint, Voice Live API key, BYOM endpoint, and model are required.");
  }

  const proxiedEndpoint = new URL("/voice-live/realtime", window.location.origin);
  proxiedEndpoint.searchParams.set("voice-live-target", voiceLiveEndpoint);
  proxiedEndpoint.searchParams.set("profile", "byom-chat-completion");
  proxiedEndpoint.searchParams.set("byom-endpoint", byomEndpoint);

  log(`Connecting through local proxy. BYOM auth headers are intentionally omitted.`);
  log(`Voice Live target: ${voiceLiveEndpoint}`);
  log(`BYOM endpoint: ${byomEndpoint}`);

  const client = new VoiceLiveClient(proxiedEndpoint.toString(), new AzureKeyCredential(voiceLiveApiKey), {
    apiVersion: "2025-05-01-preview",
  });

  session = client.createSession(model);
  session.subscribe({
    onSessionCreated: async (event) => log(`session.created id=${event.session?.id ?? "(unknown)"}`),
    onSessionUpdated: async () => log("session.updated"),
    onInputAudioBufferSpeechStarted: async () => {
      log("user speech started");
      clearPlaybackQueue();
    },
    onInputAudioBufferSpeechStopped: async () => {
      log("user speech stopped");
    },
    onConversationItemInputAudioTranscriptionCompleted: async (event) => {
      log(`user transcript: ${event.transcript}`);
    },
    onResponseCreated: async (event) => {
      responseText = "";
      responseOutput.textContent = "";
      playbackStartLogged = false;
      log(`response.created id=${event.response?.id ?? "(unknown)"}`);
    },
    onResponseTextDelta: async (event: ServerEventResponseTextDelta) => {
      responseText += event.delta;
      responseOutput.textContent = responseText;
    },
    onResponseAudioTranscriptDelta: async (event) => {
      responseText += event.delta;
      responseOutput.textContent = responseText;
    },
    onResponseAudioDelta: async (event: ServerEventResponseAudioDelta) => {
      await playPcm16Audio(event.delta);
    },
    onResponseDone: async (event) => {
      log(`response.done status=${event.response?.status ?? "(unknown)"}`);
      if (responseText.trim()) {
        log(`assistant output: ${responseText.trim()}`);
      }
    },
    onError: async (args) => {
      logError("Voice Live error", args.error);
    },
  });

  await session.connect();
  await session.updateSession({
    instructions: getInputValue("instructions"),
    modalities: ["text", "audio"],
    inputAudioFormat: "pcm16",
    inputAudioSamplingRate: TARGET_SAMPLE_RATE,
    outputAudioFormat: "pcm16",
    inputAudioTranscription: { model: "azure-speech" },
    turnDetection: {
      type: "server_vad",
      createResponse: true,
      interruptResponse: true,
      autoTruncate: true,
    },
  });

  await startMicrophone();
  connectButton.disabled = true;
  sendButton.disabled = false;
  disconnectButton.disabled = false;
}

async function sendText(): Promise<void> {
  if (!session) {
    throw new Error("Connect first.");
  }

  responseText = "";
  responseOutput.textContent = "";

  const text = getInputValue("message");
  log(`user: ${text}`);

  await session.addConversationItem({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  } as UserMessageItem);
  await session.sendEvent({ type: "response.create" });
}

async function disconnect(): Promise<void> {
  await stopMicrophone();
  await stopPlayback();
  if (session) {
    await session.disconnect();
    session = undefined;
  }

  connectButton.disabled = false;
  sendButton.disabled = true;
  disconnectButton.disabled = true;
  log("Disconnected.");
}

async function startMicrophone(): Promise<void> {
  if (!session) {
    throw new Error("Connect before starting microphone.");
  }
  await stopMicrophone();

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new AudioContext();
  mediaSource = audioContext.createMediaStreamSource(mediaStream);
  audioProcessor = audioContext.createScriptProcessor(AUDIO_PROCESSOR_BUFFER_SIZE, 1, 1);
  audioProcessor.onaudioprocess = (event) => sendMicrophoneFrame(event.inputBuffer.getChannelData(0));
  mediaSource.connect(audioProcessor);
  audioProcessor.connect(audioContext.destination);
  log(`Microphone streaming started (${audioContext.sampleRate} Hz -> ${TARGET_SAMPLE_RATE} Hz).`);
}

async function stopMicrophone(): Promise<void> {
  audioProcessor?.disconnect();
  mediaSource?.disconnect();
  for (const track of mediaStream?.getTracks() ?? []) {
    track.stop();
  }
  await audioContext?.close();
  audioProcessor = undefined;
  mediaSource = undefined;
  mediaStream = undefined;
  audioContext = undefined;
}

function sendMicrophoneFrame(inputSamples: Float32Array): void {
  if (!session || !audioContext) {
    return;
  }

  const pcmSamples = resampleToPcm16(inputSamples, audioContext.sampleRate, TARGET_SAMPLE_RATE);
  void session.sendAudio(new Uint8Array(pcmSamples.buffer)).catch((error: unknown) => {
    logError("Microphone audio send failed", error);
  });
}

function resampleToPcm16(inputSamples: Float32Array, sourceSampleRate: number, targetSampleRate: number): Int16Array {
  const outputLength = Math.max(1, Math.round((inputSamples.length * targetSampleRate) / sourceSampleRate));
  const outputSamples = new Int16Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceIndex = Math.min(inputSamples.length - 1, Math.floor((outputIndex * sourceSampleRate) / targetSampleRate));
    outputSamples[outputIndex] = floatToPcm16(inputSamples[sourceIndex]);
  }
  return outputSamples;
}

function floatToPcm16(sample: number): number {
  const clippedSample = Math.max(-PCM_SAMPLE_LIMIT, Math.min(PCM_SAMPLE_LIMIT, sample));
  return clippedSample < 0 ? clippedSample * 0x8000 : clippedSample * 0x7fff;
}

async function playPcm16Audio(audioData: Uint8Array): Promise<void> {
  if (audioData.byteOffset % 2 !== 0 || audioData.byteLength % 2 !== 0) {
    log("Skipping misaligned audio delta.");
    return;
  }

  const context = await getPlaybackContext();
  const pcmSamples = new Int16Array(audioData.buffer, audioData.byteOffset, audioData.byteLength / 2);
  const audioBuffer = context.createBuffer(1, pcmSamples.length, OUTPUT_SAMPLE_RATE);
  const channelData = audioBuffer.getChannelData(0);
  for (let index = 0; index < pcmSamples.length; index += 1) {
    channelData[index] = pcmSamples[index] / 0x8000;
  }

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);
  const startTime = Math.max(context.currentTime, nextPlaybackTime);
  if (!playbackStartLogged) {
    const delayMs = Math.max(0, Math.round((startTime - context.currentTime) * 1000));
    log(`assistant audio playback started (queued delay ${delayMs} ms)`);
    playbackStartLogged = true;
  }
  nextPlaybackTime = startTime + audioBuffer.duration;
  activePlaybackSources.add(source);
  source.onended = () => activePlaybackSources.delete(source);
  source.start(startTime);
}

async function getPlaybackContext(): Promise<AudioContext> {
  playbackAudioContext ??= new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
  if (playbackAudioContext.state === "suspended") {
    await playbackAudioContext.resume();
  }
  return playbackAudioContext;
}

function clearPlaybackQueue(): void {
  for (const source of activePlaybackSources) {
    source.stop();
  }
  activePlaybackSources.clear();
  nextPlaybackTime = playbackAudioContext?.currentTime ?? 0;
}

async function stopPlayback(): Promise<void> {
  clearPlaybackQueue();
  await playbackAudioContext?.close();
  playbackAudioContext = undefined;
  nextPlaybackTime = 0;
}

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

function restoreSavedConfig(): void {
  const savedConfig = readSavedConfig();
  for (const fieldId of CONFIG_FIELD_IDS) {
    const savedValue = savedConfig[fieldId];
    if (savedValue === undefined) {
      continue;
    }
    getElement<HTMLInputElement | HTMLTextAreaElement>(fieldId).value = savedValue;
  }
}

function setupConfigPersistence(): void {
  for (const fieldId of CONFIG_FIELD_IDS) {
    const element = getElement<HTMLInputElement | HTMLTextAreaElement>(fieldId);
    element.addEventListener("input", saveCurrentConfig);
  }
}

function saveCurrentConfig(): void {
  const config: SavedConfig = {};
  for (const fieldId of CONFIG_FIELD_IDS) {
    config[fieldId] = getElement<HTMLInputElement | HTMLTextAreaElement>(fieldId).value;
  }
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
}

function readSavedConfig(): SavedConfig {
  const rawConfig = localStorage.getItem(CONFIG_STORAGE_KEY);
  if (!rawConfig) {
    return {};
  }

  try {
    const parsedConfig: unknown = JSON.parse(rawConfig);
    if (!isSavedConfig(parsedConfig)) {
      return {};
    }
    return parsedConfig;
  } catch (error) {
    logError("Ignoring invalid saved config", error);
    return {};
  }
}

function isSavedConfig(value: unknown): value is SavedConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return CONFIG_FIELD_IDS.every((fieldId) => {
    const fieldValue = candidate[fieldId];
    return fieldValue === undefined || typeof fieldValue === "string";
  });
}

function log(message: string): void {
  logOutput.textContent += `[${new Date().toISOString()}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
  log(`${message}: ${detail}`);
  console.error(message, error);
}
