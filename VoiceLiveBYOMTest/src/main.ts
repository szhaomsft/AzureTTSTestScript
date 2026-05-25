import {
  VoiceLiveClient,
  type ServerEventResponseAudioDelta,
  type ServerEventResponseTextDelta,
  type UserMessageItem,
  type VoiceLiveSession,
} from "@azure/ai-voicelive";
import { AzureKeyCredential } from "@azure/core-auth";

import "./style.css";

let voiceLiveSession: VoiceLiveSession | undefined;
let voiceLiveResponseText = "";
let inputAudioContext: AudioContext | undefined;
let mediaStream: MediaStream | undefined;
let mediaSource: MediaStreamAudioSourceNode | undefined;
let audioProcessor: ScriptProcessorNode | undefined;
let playbackAudioContext: AudioContext | undefined;
let nextPlaybackTime = 0;
let playbackStartLogged = false;

const activePlaybackSources = new Set<AudioBufferSourceNode>();

const CONFIG_STORAGE_KEY = "voice-live-byom-test-config";
const TARGET_SAMPLE_RATE = 24_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const AUDIO_PROCESSOR_BUFFER_SIZE = 4096;
const PCM_SAMPLE_LIMIT = 1;

const TEXT_CONFIG_FIELD_IDS = [
  "voice-live-endpoint",
  "voice-live-api-key",
  "byom-endpoint",
  "model",
  "instructions",
  "message",
] as const;

type TextConfigFieldId = (typeof TEXT_CONFIG_FIELD_IDS)[number];
type SavedConfig = Partial<Record<TextConfigFieldId, string>>;

const connectButton = getElement<HTMLButtonElement>("connect");
const sendButton = getElement<HTMLButtonElement>("send");
const disconnectButton = getElement<HTMLButtonElement>("disconnect");
const clearSavedConfigButton = getElement<HTMLButtonElement>("clear-saved-config");
const voiceLiveResponseOutput = getElement<HTMLPreElement>("voice-live-response");
const voiceLiveLogOutput = getElement<HTMLPreElement>("voice-live-log");

restoreSavedConfig();
setupConfigPersistence();

connectButton.addEventListener("click", () => {
  connect().catch((error: unknown) => logVoiceLiveError("Connect failed", error));
});

sendButton.addEventListener("click", () => {
  sendText().catch((error: unknown) => logVoiceLiveError("Send failed", error));
});

disconnectButton.addEventListener("click", () => {
  disconnect().catch((error: unknown) => logVoiceLiveError("Disconnect failed", error));
});

clearSavedConfigButton.addEventListener("click", () => {
  localStorage.removeItem(CONFIG_STORAGE_KEY);
  logVoiceLive("Saved config cleared.");
});

async function connect(): Promise<void> {
  await connectVoiceLive();
  await startMicrophone();
  connectButton.disabled = true;
  sendButton.disabled = false;
  disconnectButton.disabled = false;
}

async function connectVoiceLive(): Promise<void> {
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

  logVoiceLive("Connecting through local proxy. BYOM auth headers are intentionally omitted.");
  logVoiceLive(`Voice Live target: ${voiceLiveEndpoint}`);
  logVoiceLive(`BYOM endpoint: ${byomEndpoint}`);

  const client = new VoiceLiveClient(proxiedEndpoint.toString(), new AzureKeyCredential(voiceLiveApiKey), {
    apiVersion: "2025-05-01-preview",
  });

  voiceLiveSession = client.createSession(model);
  voiceLiveSession.subscribe({
    onSessionCreated: async (event) => logVoiceLive(`session.created id=${event.session?.id ?? "(unknown)"}`),
    onSessionUpdated: async () => logVoiceLive("session.updated"),
    onInputAudioBufferSpeechStarted: async () => {
      logVoiceLive("user speech started");
      clearPlaybackQueue();
    },
    onInputAudioBufferSpeechStopped: async () => logVoiceLive("user speech stopped"),
    onConversationItemInputAudioTranscriptionCompleted: async (event) => {
      logVoiceLive(`user transcript: ${event.transcript}`);
    },
    onResponseCreated: async (event) => {
      voiceLiveResponseText = "";
      voiceLiveResponseOutput.textContent = "";
      playbackStartLogged = false;
      logVoiceLive(`response.created id=${event.response?.id ?? "(unknown)"}`);
    },
    onResponseTextDelta: async (event: ServerEventResponseTextDelta) => {
      voiceLiveResponseText += event.delta;
      voiceLiveResponseOutput.textContent = voiceLiveResponseText;
    },
    onResponseAudioTranscriptDelta: async (event) => {
      voiceLiveResponseText += event.delta;
      voiceLiveResponseOutput.textContent = voiceLiveResponseText;
    },
    onResponseAudioDelta: async (event: ServerEventResponseAudioDelta) => {
      await playVoiceLivePcm16Audio(event.delta);
    },
    onResponseDone: async (event) => {
      logVoiceLive(`response.done status=${event.response?.status ?? "(unknown)"}`);
      if (voiceLiveResponseText.trim()) {
        logVoiceLive(`assistant output: ${voiceLiveResponseText.trim()}`);
      }
    },
    onError: async (args) => logVoiceLiveError("Voice Live error", args.error),
  });

  await voiceLiveSession.connect();
  await voiceLiveSession.updateSession({
    instructions: getInputValue("instructions"),
    modalities: ["text", "audio"],
    inputAudioFormat: "pcm16",
    inputAudioSamplingRate: TARGET_SAMPLE_RATE,
    outputAudioFormat: "pcm16",
    inputAudioTranscription: { model: "azure-speech" },
    voice: { type: "azure-standard", name: "en-US-Ava:DragonHDLatestNeural" },
    turnDetection: {
      type: "server_vad",
      createResponse: true,
      interruptResponse: true,
      autoTruncate: true,
    },
  });
}

async function sendText(): Promise<void> {
  const text = getInputValue("message");
  if (!text) {
    throw new Error("User message is required.");
  }
  await sendVoiceLiveText(text);
}

async function sendVoiceLiveText(text: string): Promise<void> {
  if (!voiceLiveSession) {
    return;
  }
  voiceLiveResponseText = "";
  voiceLiveResponseOutput.textContent = "";
  logVoiceLive(`user: ${text}`);

  await voiceLiveSession.addConversationItem({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  } as UserMessageItem);
  await voiceLiveSession.sendEvent({ type: "response.create" });
}

async function disconnect(): Promise<void> {
  await stopMicrophone();
  await stopVoiceLivePlayback();
  if (voiceLiveSession) {
    await voiceLiveSession.disconnect();
    voiceLiveSession = undefined;
  }

  connectButton.disabled = false;
  sendButton.disabled = true;
  disconnectButton.disabled = true;
  logVoiceLive("Disconnected.");
}

async function startMicrophone(): Promise<void> {
  await stopMicrophone();
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  inputAudioContext = new AudioContext();
  mediaSource = inputAudioContext.createMediaStreamSource(mediaStream);
  audioProcessor = inputAudioContext.createScriptProcessor(AUDIO_PROCESSOR_BUFFER_SIZE, 1, 1);
  audioProcessor.onaudioprocess = (event) => sendMicrophoneFrame(event.inputBuffer.getChannelData(0));
  mediaSource.connect(audioProcessor);
  audioProcessor.connect(inputAudioContext.destination);
  logVoiceLive(`Microphone streaming started (${inputAudioContext.sampleRate} Hz).`);
}

async function stopMicrophone(): Promise<void> {
  audioProcessor?.disconnect();
  mediaSource?.disconnect();
  for (const track of mediaStream?.getTracks() ?? []) {
    track.stop();
  }
  await inputAudioContext?.close();
  audioProcessor = undefined;
  mediaSource = undefined;
  mediaStream = undefined;
  inputAudioContext = undefined;
}

function sendMicrophoneFrame(inputSamples: Float32Array): void {
  if (voiceLiveSession && inputAudioContext) {
    const pcmSamples = resampleToPcm16(inputSamples, inputAudioContext.sampleRate, TARGET_SAMPLE_RATE);
    void voiceLiveSession.sendAudio(new Uint8Array(pcmSamples.buffer)).catch((error: unknown) => {
      logVoiceLiveError("Microphone audio send failed", error);
    });
  }
}

function resampleToPcm16(inputSamples: Float32Array, sourceSampleRate: number, targetSampleRate: number): Int16Array {
  const outputSamples = resampleToFloat32(inputSamples, sourceSampleRate, targetSampleRate);
  const pcmSamples = new Int16Array(outputSamples.length);
  for (let index = 0; index < outputSamples.length; index += 1) {
    pcmSamples[index] = floatToPcm16(outputSamples[index]);
  }
  return pcmSamples;
}

function resampleToFloat32(inputSamples: Float32Array, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  const outputLength = Math.max(1, Math.round((inputSamples.length * targetSampleRate) / sourceSampleRate));
  const outputSamples = new Float32Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceIndex = Math.min(inputSamples.length - 1, Math.floor((outputIndex * sourceSampleRate) / targetSampleRate));
    outputSamples[outputIndex] = inputSamples[sourceIndex];
  }
  return outputSamples;
}

function floatToPcm16(sample: number): number {
  const clippedSample = Math.max(-PCM_SAMPLE_LIMIT, Math.min(PCM_SAMPLE_LIMIT, sample));
  return clippedSample < 0 ? clippedSample * 0x8000 : clippedSample * 0x7fff;
}

async function playVoiceLivePcm16Audio(audioData: Uint8Array): Promise<void> {
  if (audioData.byteOffset % 2 !== 0 || audioData.byteLength % 2 !== 0) {
    logVoiceLive("Skipping misaligned audio delta.");
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
    logVoiceLive(`assistant audio playback started (queued delay ${delayMs} ms)`);
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

async function stopVoiceLivePlayback(): Promise<void> {
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
  for (const fieldId of TEXT_CONFIG_FIELD_IDS) {
    const savedValue = savedConfig[fieldId];
    if (savedValue !== undefined) {
      getElement<HTMLInputElement | HTMLTextAreaElement>(fieldId).value = savedValue;
    }
  }
}

function setupConfigPersistence(): void {
  for (const fieldId of TEXT_CONFIG_FIELD_IDS) {
    getElement<HTMLInputElement | HTMLTextAreaElement>(fieldId).addEventListener("input", saveCurrentConfig);
  }
}

function saveCurrentConfig(): void {
  const config: SavedConfig = {};
  for (const fieldId of TEXT_CONFIG_FIELD_IDS) {
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
  } catch {
    return {};
  }
}

function isSavedConfig(value: unknown): value is SavedConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return TEXT_CONFIG_FIELD_IDS.every((fieldId) => {
    const fieldValue = candidate[fieldId];
    return fieldValue === undefined || typeof fieldValue === "string";
  });
}

function logVoiceLive(message: string): void {
  appendLog(voiceLiveLogOutput, message);
}

function appendLog(target: HTMLPreElement, message: string): void {
  target.textContent += `[${new Date().toISOString()}] ${message}\n`;
  target.scrollTop = target.scrollHeight;
}

function logVoiceLiveError(message: string, error: unknown): void {
  logVoiceLive(`${message}: ${formatError(error)}`);
  console.error(message, error);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "[object Object]" ? error.name : `${error.name}: ${error.message}`;
  }
  return JSON.stringify(error);
}
