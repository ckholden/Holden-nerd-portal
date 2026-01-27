/**
 * CADRadio Module — HOSCAD Radio Integration
 *
 * Self-contained 4-channel PTT radio using Firebase Realtime Database.
 * Compatible with holdenptt (holdenptt-ce145) audio format.
 *
 * Usage:
 *   CADRadio.init()
 *   CADRadio.login(callsign, roomPassword)
 *   CADRadio.cleanup()
 */

const CADRadio = {
  // ── Configuration ──
  FIREBASE_CONFIG: {
    apiKey: "AIzaSyDnC6f9qmwCKO5KqVOaEikAQleIN87NxS8",
    authDomain: "holdenptt-ce145.firebaseapp.com",
    databaseURL: "https://holdenptt-ce145-default-rtdb.firebaseio.com",
    projectId: "holdenptt-ce145",
    storageBucket: "holdenptt-ce145.firebasestorage.app",
    messagingSenderId: "60027169649",
    appId: "1:60027169649:web:6a43b7d8357bb2e095e4d0"
  },
  ROOM_PASSWORD: "12345",
  DB_PREFIX: "cadradio/",
  SAMPLE_RATE: 16000,
  CHUNK_INTERVAL: 200,

  // ── State ──
  channels: ['main', 'channel2', 'channel3', 'channel4'],
  channelNames: { main: 'CH1', channel2: 'CH2', channel3: 'CH3', channel4: 'CH4' },
  txChannel: null,
  rxEnabled: { main: true, channel2: false, channel3: false, channel4: false },
  rxActivity: { main: false, channel2: false, channel3: false, channel4: false },
  activeSpeakers: {},
  isTransmitting: false,
  _ready: false,
  _txPending: false,   // true while async TX setup is in progress
  _wantStop: false,     // pointerup fired during async TX setup

  // ── Firebase refs ──
  firebaseApp: null,
  firebaseAuth: null,
  firebaseDb: null,
  userId: null,
  callsign: '',
  speakerRefs: {},
  audioStreamRefs: {},
  userRef: null,

  // ── Audio ──
  audioContext: null,
  gainNode: null,
  localStream: null,
  _captureCtx: null,
  captureSource: null,
  captureNode: null,
  chunkBuffer: [],
  sendInterval: null,
  _playbackTimes: {},
  _audioUnlocked: false,
  _meterInterval: null,
  _meterAnalyser: null,
  _joinedAt: 0,         // timestamp to ignore stale audio data

  // ============================================================
  // INIT
  // ============================================================
  init() {
    try {
      if (firebase.apps && firebase.apps.find(a => a.name === 'radio')) {
        this.firebaseApp = firebase.apps.find(a => a.name === 'radio');
      } else {
        this.firebaseApp = firebase.initializeApp(this.FIREBASE_CONFIG, 'radio');
      }
      this.firebaseAuth = this.firebaseApp.auth();
      this.firebaseDb = this.firebaseApp.database();
      console.log('[CADRadio] Firebase initialized (app: radio)');
    } catch (err) {
      console.error('[CADRadio] Firebase init failed:', err);
    }
  },

  // ============================================================
  // LOGIN
  // ============================================================
  async login(callsign, password) {
    if (!this.firebaseAuth) { console.error('[CADRadio] Not initialized'); return false; }
    if (password !== this.ROOM_PASSWORD) { console.warn('[CADRadio] Bad room password'); return false; }

    try {
      const cred = await this.firebaseAuth.signInAnonymously();
      this.userId = cred.user.uid;
      this.callsign = callsign;

      // Set presence
      this.userRef = this.firebaseDb.ref(this.DB_PREFIX + 'users/' + this.userId);
      await this.userRef.set({
        displayName: callsign,
        online: true,
        currentChannel: 'main',
        lastSeen: firebase.database.ServerValue.TIMESTAMP,
        kicked: false
      });
      this.userRef.onDisconnect().update({
        online: false,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });

      // Pre-request microphone so first PTT press is instant
      try { await this._requestMic(); } catch (e) {}

      // Unlock audio context with user gesture context still active
      this._unlockAudio();

      this._ready = true;
      this._joinedAt = Date.now();
      this.joinAllChannels();
      this._showBar(true);
      console.log('[CADRadio] Logged in as', callsign);
      return true;
    } catch (err) {
      console.error('[CADRadio] Login failed:', err);
      return false;
    }
  },

  // ============================================================
  // JOIN ALL CHANNELS (multi-channel RX)
  // ============================================================
  joinAllChannels() {
    const joinTime = this._joinedAt;

    this.channels.forEach(ch => {
      // Listen for active speaker on every channel (RX activity LEDs)
      const spRef = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + ch + '/activeSpeaker');
      this.speakerRefs[ch] = spRef;
      spRef.on('value', snap => this._onSpeakerChange(ch, snap.val()));

      // Listen for audio stream — skip stale data from before we joined
      const asRef = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + ch + '/audioStream');
      this.audioStreamRefs[ch] = asRef;

      // Use a flag: ignore all child_added events until initial load completes
      let initialLoadDone = false;
      asRef.once('value', () => {
        // This fires AFTER all initial child_added events are delivered
        initialLoadDone = true;
      });

      asRef.on('child_added', snap => {
        if (!initialLoadDone) return; // skip stale data from before we joined
        const data = snap.val();
        if (data && data.sid !== this.userId) {
          this._receiveChunk(ch, data.pcm);
        }
      });
    });
  },

  // ============================================================
  // SPEAKER CHANGE HANDLER
  // ============================================================
  _onSpeakerChange(channel, speaker) {
    const prevActive = this.rxActivity[channel];
    const led = document.getElementById('rxLed-' + channel);

    if (speaker) {
      this.activeSpeakers[channel] = speaker;
      this.rxActivity[channel] = true;
      if (led) { led.classList.add('active'); }

      if (speaker.userId === this.userId) {
        this._setTxStatus('TX: ' + this.channelNames[channel], 'transmitting');
      } else if (this.rxEnabled[channel]) {
        this._setTxStatus('RX: ' + this.channelNames[channel] + ' — ' + speaker.displayName, 'receiving');
        this._playbackTimes[channel] = 0;
      }
    } else {
      this.activeSpeakers[channel] = null;
      this.rxActivity[channel] = false;
      if (led) { led.classList.remove('active'); }

      if (!this.isTransmitting && !this._txPending && !this._anyRxActive()) {
        this._setTxStatus('STANDBY', '');
      }
    }
  },

  _anyRxActive() {
    return this.channels.some(ch => this.rxActivity[ch] && this.rxEnabled[ch]);
  },

  // ============================================================
  // TRANSMIT — robust async handling
  // ============================================================
  async handleTXDown(channel) {
    if (this.isTransmitting || this._txPending || !this._ready) return;

    this._txPending = true;
    this._wantStop = false;

    // Mic should already be available from login pre-request
    if (!this.localStream) {
      const ok = await this._requestMic();
      if (!ok || this._wantStop) { this._txPending = false; return; }
    }

    this._unlockAudio();

    // Check if user released button during mic request
    if (this._wantStop) { this._txPending = false; return; }

    // Check if channel is busy
    if (this.activeSpeakers[channel] && this.activeSpeakers[channel].userId !== this.userId) {
      this._txPending = false;
      return;
    }

    // Claim speaker via Firebase transaction
    const ref = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/activeSpeaker');
    try {
      const result = await ref.transaction(current => {
        if (!current || current.userId === this.userId) {
          return {
            userId: this.userId,
            displayName: this.callsign,
            timestamp: firebase.database.ServerValue.TIMESTAMP
          };
        }
        return undefined;
      });
      if (!result.committed) { this._txPending = false; return; }
    } catch (err) {
      console.error('[CADRadio] TX claim error:', err);
      this._txPending = false;
      return;
    }

    // Check if user released during transaction
    if (this._wantStop) {
      this._txPending = false;
      // Release the speaker we just claimed
      try {
        await ref.transaction(c => (c && c.userId === this.userId) ? null : c);
        ref.onDisconnect().cancel();
      } catch (e) {}
      return;
    }

    // TX is now fully active
    this.isTransmitting = true;
    this._txPending = false;
    this.txChannel = channel;
    ref.onDisconnect().remove();

    // Clear old audio stream
    await this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/audioStream').remove();

    this._startCapture(channel);

    // UI
    const btn = document.querySelector('.radio-tx-btn[data-ch="' + channel + '"]');
    if (!btn) {
      // Standalone page uses .ptt-btn
      const pttBtn = document.querySelector('.ptt-btn[data-ch="' + channel + '"]');
      if (pttBtn) pttBtn.classList.add('transmitting');
    } else {
      btn.classList.add('transmitting');
    }
    this._setTxStatus('TX: ' + this.channelNames[channel], 'transmitting');
    this._startMeter();
  },

  handleTXUp() {
    if (this._txPending) {
      // Async TX setup still in progress — flag that we want to cancel
      this._wantStop = true;
      return;
    }
    if (!this.isTransmitting) return;
    this._stopTX();
  },

  async _stopTX() {
    if (!this.isTransmitting) return;
    const channel = this.txChannel;
    this.isTransmitting = false;
    this.txChannel = null;

    this._stopCapture();
    this._stopMeter();

    if (channel) {
      this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/audioStream').remove();

      const ref = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/activeSpeaker');
      try {
        await ref.transaction(current => {
          if (current && current.userId === this.userId) return null;
          return current;
        });
        ref.onDisconnect().cancel();
      } catch (err) {
        console.error('[CADRadio] TX release error:', err);
      }

      const btn = document.querySelector('.radio-tx-btn[data-ch="' + channel + '"]');
      if (btn) btn.classList.remove('transmitting');
      const pttBtn = document.querySelector('.ptt-btn[data-ch="' + channel + '"]');
      if (pttBtn) pttBtn.classList.remove('transmitting');
    }

    if (!this._anyRxActive()) {
      this._setTxStatus('STANDBY', '');
    }
  },

  // ============================================================
  // AUDIO CAPTURE
  // ============================================================
  _startCapture(channel) {
    const streamRef = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/audioStream');
    const senderId = this.userId;

    const captureCtx = new (window.AudioContext || window.webkitAudioContext)();
    const nativeRate = captureCtx.sampleRate;
    const targetRate = this.SAMPLE_RATE;

    const source = captureCtx.createMediaStreamSource(this.localStream);
    const processor = captureCtx.createScriptProcessor(4096, 1, 1);

    this._meterAnalyser = captureCtx.createAnalyser();
    this._meterAnalyser.fftSize = 256;
    source.connect(this._meterAnalyser);

    this.chunkBuffer = [];
    let chunkCount = 0;

    processor.onaudioprocess = (e) => {
      if (!this.isTransmitting) return;
      const input = e.inputBuffer.getChannelData(0);

      const ratio = nativeRate / targetRate;
      const downLen = Math.floor(input.length / ratio);
      const int16 = new Int16Array(downLen);
      for (let i = 0; i < downLen; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = input[idx] || 0;
        const b = input[Math.min(idx + 1, input.length - 1)] || 0;
        const s = Math.max(-1, Math.min(1, a + frac * (b - a)));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      const bytes = new Uint8Array(int16.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      this.chunkBuffer.push(btoa(binary));
    };

    source.connect(processor);
    const silencer = captureCtx.createGain();
    silencer.gain.value = 0;
    processor.connect(silencer);
    silencer.connect(captureCtx.destination);

    this.captureSource = source;
    this.captureNode = processor;
    this._captureCtx = captureCtx;

    this.sendInterval = setInterval(() => {
      if (this.chunkBuffer.length > 0 && this.isTransmitting) {
        const chunks = this.chunkBuffer.splice(0);
        const combined = chunks.join('|');
        chunkCount++;
        streamRef.push({
          pcm: combined,
          sid: senderId,
          t: firebase.database.ServerValue.TIMESTAMP,
          n: chunkCount
        });
      }
    }, this.CHUNK_INTERVAL);
  },

  _stopCapture() {
    if (this.sendInterval) { clearInterval(this.sendInterval); this.sendInterval = null; }
    if (this.captureNode) { this.captureNode.disconnect(); this.captureNode = null; }
    if (this.captureSource) { this.captureSource.disconnect(); this.captureSource = null; }
    if (this._captureCtx) { this._captureCtx.close().catch(() => {}); this._captureCtx = null; }
    this._meterAnalyser = null;
    this.chunkBuffer = [];
  },

  // ============================================================
  // RECEIVE & PLAYBACK
  // ============================================================
  _receiveChunk(channel, pcmData) {
    if (!pcmData || !this.rxEnabled[channel]) return;

    const ctx = this._getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();

    const chunks = pcmData.split('|');
    const allSamples = [];

    for (const chunk of chunks) {
      try {
        const binary = atob(chunk);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const int16 = new Int16Array(bytes.buffer);
        for (let i = 0; i < int16.length; i++) {
          allSamples.push(int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF));
        }
      } catch (err) {
        console.error('[CADRadio] Decode error:', err);
      }
    }

    if (allSamples.length === 0) return;
    const float32 = new Float32Array(allSamples);
    this._schedulePlayback(channel, float32);
  },

  _schedulePlayback(channel, samples) {
    const ctx = this.audioContext;
    if (!ctx) return;

    const buffer = ctx.createBuffer(1, samples.length, this.SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);

    const now = ctx.currentTime;
    // Gapless scheduling: chain buffers back-to-back.
    // Reset if we've fallen behind or jumped too far ahead (1s max lookahead).
    if (!this._playbackTimes[channel] ||
        this._playbackTimes[channel] < now ||
        this._playbackTimes[channel] > now + 1.0) {
      this._playbackTimes[channel] = now;
    }
    source.start(this._playbackTimes[channel]);
    this._playbackTimes[channel] += buffer.duration;
  },

  // ============================================================
  // RX TOGGLE
  // ============================================================
  toggleRX(channel, enabled) {
    this.rxEnabled[channel] = enabled;
  },

  // ============================================================
  // VOLUME
  // ============================================================
  setVolume(val) {
    const v = Math.max(0, Math.min(100, parseInt(val) || 0));
    if (this.gainNode) {
      this.gainNode.gain.value = v / 100;
    }
    const slider = document.getElementById('radioVolume');
    if (slider && parseInt(slider.value) !== v) slider.value = v;
  },

  // ============================================================
  // AUDIO CONTEXT & MIC
  // ============================================================
  _getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 0.8;
      this.gainNode.connect(this.audioContext.destination);
    }
    return this.audioContext;
  },

  _unlockAudio() {
    if (this._audioUnlocked) return;
    this._audioUnlocked = true;
    const ctx = this._getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  },

  async _requestMic() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      return true;
    } catch (err) {
      console.error('[CADRadio] Mic denied:', err);
      return false;
    }
  },

  // ============================================================
  // TX STATUS DISPLAY
  // ============================================================
  _setTxStatus(text, cls) {
    const el = document.getElementById('radioTxStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'radio-tx-text' + (cls ? ' ' + cls : '');
  },

  // ============================================================
  // AUDIO METER
  // ============================================================
  _startMeter() {
    const fill = document.getElementById('radioMeterFill');
    if (!fill) return;
    this._meterInterval = setInterval(() => {
      if (!this._meterAnalyser) { fill.style.width = '0%'; return; }
      const data = new Uint8Array(this._meterAnalyser.frequencyBinCount);
      this._meterAnalyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      const pct = Math.min(100, (avg / 128) * 100);
      fill.style.width = pct + '%';
    }, 50);
  },

  _stopMeter() {
    if (this._meterInterval) { clearInterval(this._meterInterval); this._meterInterval = null; }
    const fill = document.getElementById('radioMeterFill');
    if (fill) fill.style.width = '0%';
  },

  // ============================================================
  // SHOW/HIDE RADIO BAR
  // ============================================================
  _showBar(visible) {
    const bar = document.getElementById('radioBar');
    if (bar) bar.style.display = visible ? 'flex' : 'none';
  },

  show() { this._showBar(true); },
  hide() { this._showBar(false); },

  // ============================================================
  // CLEANUP
  // ============================================================
  async cleanup() {
    if (this.isTransmitting) await this._stopTX();
    this._txPending = false;
    this._wantStop = false;
    this._stopCapture();
    this._stopMeter();

    this.channels.forEach(ch => {
      if (this.speakerRefs[ch]) { this.speakerRefs[ch].off(); }
      if (this.audioStreamRefs[ch]) { this.audioStreamRefs[ch].off(); }
    });
    this.speakerRefs = {};
    this.audioStreamRefs = {};

    if (this.userRef) {
      try {
        await this.userRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
      } catch (e) {}
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
    this.gainNode = null;
    this._audioUnlocked = false;
    this._playbackTimes = {};

    if (this.firebaseAuth) {
      try { await this.firebaseAuth.signOut(); } catch (e) {}
    }

    this._ready = false;
    this.userId = null;
    this.callsign = '';
    this.userRef = null;

    this._showBar(false);
    console.log('[CADRadio] Cleanup complete');
  }
};
