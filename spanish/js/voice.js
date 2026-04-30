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
  constructor({ onStateChange = () => {}, onSilence = null, silenceMs = 1500, silenceThreshold = 0.012 } = {}) {
    this.state = 'idle'; // 'idle' | 'requesting' | 'recording' | 'processing'
    this.recorder = null;
    this.chunks = [];
    this.stream = null;
    this.mimeType = '';
    this.onStateChange = onStateChange;
    // Silence detection (used in Conversation Mode for hands-free auto-stop)
    this.onSilence = onSilence;
    this.silenceMs = silenceMs;          // how long of silence triggers auto-stop
    this.silenceThreshold = silenceThreshold; // RMS amplitude below this = "silent"
    this._analyserCtx = null;
    this._analyserNode = null;
    this._analyserSource = null;
    this._silenceTimer = null;
    this._lastSoundAt = 0;
    this._sawSpeech = false;
    this._raf = null;
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

      // Silence detection (only if onSilence callback was provided)
      if (this.onSilence) this._startSilenceWatch();
    } catch (err) {
      this._setState('idle');
      throw err;
    }
  }

  _startSilenceWatch() {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      this._analyserCtx = ctx;
      this._analyserSource = ctx.createMediaStreamSource(this.stream);
      this._analyserNode = ctx.createAnalyser();
      this._analyserNode.fftSize = 1024;
      this._analyserSource.connect(this._analyserNode);

      const buf = new Uint8Array(this._analyserNode.fftSize);
      this._lastSoundAt = Date.now();
      this._sawSpeech = false;

      const tick = () => {
        if (this.state !== 'recording') return;
        this._analyserNode.getByteTimeDomainData(buf);
        // RMS amplitude over the buffer
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);

        if (rms > this.silenceThreshold) {
          this._lastSoundAt = Date.now();
          this._sawSpeech = true;
        } else if (this._sawSpeech && Date.now() - this._lastSoundAt > this.silenceMs) {
          // Triggered: user paused after speaking
          if (this.onSilence) this.onSilence();
          return; // stop the loop
        }
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    } catch {
      // Analyser failed — fall back to manual stop
    }
  }

  _teardownAnalyser() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    try { this._analyserSource?.disconnect(); } catch {}
    this._analyserSource = null;
    this._analyserNode = null;
  }

  /** Stops recording and resolves to a Blob. */
  async stopAndGetBlob() {
    if (this.state !== 'recording' || !this.recorder) return null;

    this._teardownAnalyser();

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

    // Reject empty/silent blobs (no actual speech captured)
    if (!blob || blob.size < 1500) return null;

    return blob;
  }

  cancel() {
    this._teardownAnalyser();
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

/**
 * True if the user has TTS muted (single source of truth: localStorage).
 * Read fresh every time so stale closures or duplicate handlers can't
 * override the user's choice.
 */
export function isTtsMuted() {
  return localStorage.getItem('ttsEnabled') === 'false';
}

/**
 * Speak text. Respects the global mute UNLESS `force: true` is passed
 * (used by Conversation Mode, which is a voice-only mode).
 */
export async function speak(text, { rate = 0.95, voiceURI = null, force = false } = {}) {
  if (!text || !window.speechSynthesis) return;
  if (!force && isTtsMuted()) return; // ← authoritative mute check

  const cleanText = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\n+/g, '. ')
    .trim();
  if (!cleanText) return;

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

/**
 * Wait until any in-flight TTS has finished playing.
 * Used by Conversation Mode to chain: Lupita-speaks → user-speaks → repeat.
 */
export function waitForSpeechEnd() {
  return new Promise((resolve) => {
    if (!window.speechSynthesis?.speaking) return resolve();
    const t = setInterval(() => {
      if (!window.speechSynthesis.speaking) { clearInterval(t); resolve(); }
    }, 200);
  });
}
