import { getIdToken } from './auth.js';

const WORKER_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8787'
  : 'https://maestra-lupita-worker.christiankholden.workers.dev';

// ---------------------------------------------------------------------------
// AudioContext (singleton, unlocked on first user gesture for iOS)
// ---------------------------------------------------------------------------

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = Ctor ? new Ctor() : null;
  }
  return audioCtx;
}

/** Must be called from inside a user gesture handler (button click, tap). */
export async function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Audio format detection (iOS Safari → mp4, others → webm)
// ---------------------------------------------------------------------------

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return ''; // browser will pick default
}

function fileExtensionForMime(mime) {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

// ---------------------------------------------------------------------------
// Recorder — tap to start, tap to stop
// ---------------------------------------------------------------------------

export class VoiceRecorder {
  constructor({ onStateChange = () => {} } = {}) {
    this.state = 'idle'; // 'idle' | 'requesting' | 'recording' | 'processing'
    this.recorder = null;
    this.chunks = [];
    this.stream = null;
    this.mimeType = '';
    this.onStateChange = onStateChange;
  }

  _setState(s) {
    this.state = s;
    this.onStateChange(s);
  }

  async start() {
    if (this.state !== 'idle') return;
    this._setState('requesting');

    try {
      await unlockAudio(); // iOS — must be inside user gesture

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.mimeType = pickMimeType();
      this.recorder = this.mimeType
        ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
        : new MediaRecorder(this.stream);
      this.chunks = [];

      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };

      this.recorder.start();
      this._setState('recording');
    } catch (err) {
      this._setState('idle');
      throw err;
    }
  }

  /** Stops recording and resolves to a Blob. */
  async stopAndGetBlob() {
    if (this.state !== 'recording' || !this.recorder) return null;

    const recorder = this.recorder;
    const chunks = this.chunks;
    const mime = this.mimeType || recorder.mimeType || 'audio/webm';

    this._setState('processing');

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
      recorder.stop();
    });

    // Release the mic
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.recorder = null;
    this.chunks = [];

    return blob;
  }

  cancel() {
    if (this.recorder && this.state === 'recording') {
      try { this.recorder.stop(); } catch {}
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.recorder = null;
    this.chunks = [];
    this._setState('idle');
  }

  reset() {
    this._setState('idle');
  }
}

// ---------------------------------------------------------------------------
// Whisper upload
// ---------------------------------------------------------------------------

export async function transcribe(blob) {
  const ext = fileExtensionForMime(blob.type);
  const fd = new FormData();
  fd.append('audio', blob, `voice.${ext}`);

  const token = await getIdToken();
  const resp = await fetch(`${WORKER_BASE}/transcribe`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: fd,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || `Transcribe failed: ${resp.status}`);
  }

  const data = await resp.json();
  return (data.text || '').trim();
}

// ---------------------------------------------------------------------------
// TTS — browser SpeechSynthesis with es-MX voice preference
// ---------------------------------------------------------------------------

let cachedVoices = null;

function loadVoices() {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve([]);
    const v = synth.getVoices();
    if (v && v.length) return resolve(v);
    // Chrome populates voices async — wait for the event
    synth.onvoiceschanged = () => resolve(synth.getVoices());
    // Fallback timeout in case the event never fires
    setTimeout(() => resolve(synth.getVoices() ?? []), 1500);
  });
}

export async function getSpanishVoices() {
  if (cachedVoices) return cachedVoices;
  const all = await loadVoices();
  cachedVoices = all.filter((v) => v.lang && v.lang.toLowerCase().startsWith('es'));
  return cachedVoices;
}

export async function pickPreferredVoice(savedVoiceURI = null) {
  const voices = await getSpanishVoices();
  if (savedVoiceURI) {
    const match = voices.find((v) => v.voiceURI === savedVoiceURI);
    if (match) return match;
  }
  // Preference: es-MX → es-US → es-419 → any es-*
  return (
    voices.find((v) => v.lang.toLowerCase() === 'es-mx') ??
    voices.find((v) => v.lang.toLowerCase() === 'es-us') ??
    voices.find((v) => v.lang.toLowerCase() === 'es-419') ??
    voices[0] ??
    null
  );
}

let currentUtterance = null;

export async function speak(text, { rate = 0.95, voiceURI = null } = {}) {
  if (!text || !window.speechSynthesis) return;

  // Strip emojis and markdown for cleaner TTS audio
  const cleanText = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\n+/g, '. ')
    .trim();
  if (!cleanText) return;

  // Cancel any in-flight utterance
  cancelSpeech();

  const utt = new SpeechSynthesisUtterance(cleanText);
  utt.voice = await pickPreferredVoice(voiceURI);
  utt.lang = utt.voice?.lang || 'es-MX';
  utt.rate = rate;

  currentUtterance = utt;
  window.speechSynthesis.speak(utt);
}

export function cancelSpeech() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function isSpeaking() {
  return !!(window.speechSynthesis && window.speechSynthesis.speaking);
}
