/**
 * CADRadio Module — HOSCAD Radio Integration
 *
 * Self-contained 4-channel PTT radio using Firebase Realtime Database.
 * Compatible with holdenptt (holdenptt-ce145) audio format.
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
  _bound: false,

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
      console.log('[CADRadio] Firebase initialized');
    } catch (err) {
      console.error('[CADRadio] Firebase init failed:', err);
    }
  },

  // ============================================================
  // LOGIN — no mic request here (needs fresh user gesture on PTT)
  // ============================================================
  async login(callsign, password) {
    if (!this.firebaseAuth) { console.error('[CADRadio] Not initialized'); return false; }
    if (password !== this.ROOM_PASSWORD) { console.warn('[CADRadio] Bad room password'); return false; }

    try {
      const cred = await this.firebaseAuth.signInAnonymously();
      this.userId = cred.user.uid;
      this.callsign = callsign;

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

      this._ready = true;
      this.joinAllChannels();
      this._showBar(true);
      console.log('[CADRadio] Logged in as', callsign, '| uid:', this.userId);
      return true;
    } catch (err) {
      console.error('[CADRadio] Login failed:', err);
      return false;
    }
  },

  // ============================================================
  // BIND PTT BUTTONS — attach event listeners (not inline handlers)
  // ============================================================
  _bindButtons() {
    if (this._bound) return;
    this._bound = true;
    const self = this;

    // PTT buttons (both .radio-tx-btn for CAD bar and .ptt-btn for standalone)
    document.querySelectorAll('.radio-tx-btn, .ptt-btn').forEach(btn => {
      const ch = btn.dataset.ch;
      if (!ch) return;

      btn.addEventListener('pointerdown', function(e) {
        e.preventDefault();
        self._onPTTDown(ch, this);
      });
      btn.addEventListener('pointerup', function(e) {
        e.preventDefault();
        self._onPTTUp();
      });
      btn.addEventListener('pointerleave', function() {
        self._onPTTUp();
      });
      btn.addEventListener('pointercancel', function() {
        self._onPTTUp();
      });
      // Prevent context menu on long press (mobile)
      btn.addEventListener('contextmenu', function(e) {
        e.preventDefault();
      });
    });

    // RX toggles
    document.querySelectorAll('[data-rx-ch]').forEach(cb => {
      const ch = cb.dataset.rxCh;
      cb.addEventListener('change', function() {
        self.toggleRX(ch, this.checked);
      });
    });

    // Volume
    const vol = document.getElementById('radioVolume');
    if (vol) {
      vol.addEventListener('input', function() {
        self.setVolume(this.value);
      });
    }
  },

  // ============================================================
  // PTT EVENT HANDLERS — synchronous entry, then async work
  // ============================================================
  _onPTTDown(channel, btnEl) {
    if (this.isTransmitting || !this._ready) {
      console.log('[CADRadio] PTT blocked: transmitting=', this.isTransmitting, 'ready=', this._ready);
      return;
    }

    this._setTxStatus('TX: ' + this.channelNames[channel], 'transmitting');
    if (btnEl) btnEl.classList.add('transmitting');

    // Request mic SYNCHRONOUSLY in the user gesture context (before any async)
    // This ensures the browser sees it as triggered by a user action
    let micPromise = null;
    if (!this.localStream) {
      this._setTxStatus('MIC REQUEST...', 'transmitting');
      micPromise = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    }

    // Kick off async TX setup with the mic promise
    this._startTX(channel, btnEl, micPromise);
  },

  _onPTTUp() {
    if (!this.isTransmitting) return;
    this._stopTX();
  },

  // ============================================================
  // TX START — async, called from _onPTTDown
  // ============================================================
  async _startTX(channel, btnEl, micPromise) {
    // Await mic if we needed to request it (promise was started synchronously in pointerdown)
    if (micPromise) {
      try {
        this.localStream = await micPromise;
        console.log('[CADRadio] Mic granted');
      } catch (err) {
        console.error('[CADRadio] Mic denied:', err);
        this._setTxStatus('MIC DENIED', '');
        if (btnEl) btnEl.classList.remove('transmitting');
        setTimeout(() => {
          if (!this.isTransmitting) this._setTxStatus('STANDBY', '');
        }, 2000);
        return;
      }
    }

    // Unlock audio playback context
    this._unlockAudio();

    // Check channel busy
    if (this.activeSpeakers[channel] && this.activeSpeakers[channel].userId !== this.userId) {
      this._setTxStatus('CHANNEL BUSY', '');
      if (btnEl) btnEl.classList.remove('transmitting');
      setTimeout(() => {
        if (!this.isTransmitting) this._setTxStatus('STANDBY', '');
      }, 1500);
      return;
    }

    // Claim speaker
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
      if (!result.committed) {
        this._setTxStatus('CHANNEL BUSY', '');
        if (btnEl) btnEl.classList.remove('transmitting');
        setTimeout(() => {
          if (!this.isTransmitting) this._setTxStatus('STANDBY', '');
        }, 1500);
        return;
      }
    } catch (err) {
      console.error('[CADRadio] TX claim error:', err);
      this._setTxStatus('TX ERROR', '');
      if (btnEl) btnEl.classList.remove('transmitting');
      return;
    }

    // Now fully transmitting
    this.isTransmitting = true;
    this.txChannel = channel;
    ref.onDisconnect().remove();

    // Clear old stream and start capture
    await this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/audioStream').remove();
    this._startCapture(channel);
    this._setTxStatus('TX: ' + this.channelNames[channel], 'transmitting');
    this._startMeter();

    console.log('[CADRadio] TX started on', channel);
  },

  // ============================================================
  // TX STOP
  // ============================================================
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

      // Remove transmitting class from all PTT buttons for this channel
      document.querySelectorAll('[data-ch="' + channel + '"]').forEach(el => {
        el.classList.remove('transmitting');
      });
    }

    if (!this._anyRxActive()) {
      this._setTxStatus('STANDBY', '');
    }
    console.log('[CADRadio] TX stopped');
  },

  // ============================================================
  // JOIN ALL CHANNELS
  // ============================================================
  joinAllChannels() {
    this.channels.forEach(ch => {
      const spRef = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + ch + '/activeSpeaker');
      this.speakerRefs[ch] = spRef;
      spRef.on('value', snap => this._onSpeakerChange(ch, snap.val()));

      const asRef = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + ch + '/audioStream');
      this.audioStreamRefs[ch] = asRef;

      // Skip stale data: ignore initial child_added batch
      let initialLoadDone = false;
      asRef.once('value', () => { initialLoadDone = true; });

      asRef.on('child_added', snap => {
        if (!initialLoadDone) return;
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
    const led = document.getElementById('rxLed-' + channel);

    if (speaker) {
      this.activeSpeakers[channel] = speaker;
      this.rxActivity[channel] = true;
      if (led) led.classList.add('active');

      if (speaker.userId === this.userId) {
        this._setTxStatus('TX: ' + this.channelNames[channel], 'transmitting');
      } else if (this.rxEnabled[channel]) {
        this._setTxStatus('RX: ' + this.channelNames[channel] + ' — ' + speaker.displayName, 'receiving');
        this._playbackTimes[channel] = 0;
      }
    } else {
      this.activeSpeakers[channel] = null;
      this.rxActivity[channel] = false;
      if (led) led.classList.remove('active');

      if (!this.isTransmitting && !this._anyRxActive()) {
        this._setTxStatus('STANDBY', '');
      }
    }
  },

  _anyRxActive() {
    return this.channels.some(ch => this.rxActivity[ch] && this.rxEnabled[ch]);
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
      } catch (err) {}
    }

    if (allSamples.length === 0) return;
    this._schedulePlayback(channel, new Float32Array(allSamples));
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
    if (!this._playbackTimes[channel] ||
        this._playbackTimes[channel] < now ||
        this._playbackTimes[channel] > now + 1.0) {
      this._playbackTimes[channel] = now;
    }
    source.start(this._playbackTimes[channel]);
    this._playbackTimes[channel] += buffer.duration;
  },

  // ============================================================
  // RX / VOLUME
  // ============================================================
  toggleRX(channel, enabled) {
    this.rxEnabled[channel] = enabled;
  },

  setVolume(val) {
    const v = Math.max(0, Math.min(100, parseInt(val) || 0));
    if (this.gainNode) this.gainNode.gain.value = v / 100;
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
      console.log('[CADRadio] Mic granted');
      return true;
    } catch (err) {
      console.error('[CADRadio] Mic denied:', err);
      return false;
    }
  },

  // ============================================================
  // UI HELPERS
  // ============================================================
  _setTxStatus(text, cls) {
    const el = document.getElementById('radioTxStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'radio-tx-text' + (cls ? ' ' + cls : '');
  },

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
      fill.style.width = Math.min(100, (avg / 128) * 100) + '%';
    }, 50);
  },

  _stopMeter() {
    if (this._meterInterval) { clearInterval(this._meterInterval); this._meterInterval = null; }
    const fill = document.getElementById('radioMeterFill');
    if (fill) fill.style.width = '0%';
  },

  _showBar(visible) {
    const bar = document.getElementById('radioBar');
    if (bar) bar.style.display = visible ? 'flex' : 'none';
    if (visible) this._bindButtons();
  },

  show() { this._showBar(true); },
  hide() { this._showBar(false); },

  // ============================================================
  // CLEANUP
  // ============================================================
  async cleanup() {
    if (this.isTransmitting) await this._stopTX();
    this._stopCapture();
    this._stopMeter();

    this.channels.forEach(ch => {
      if (this.speakerRefs[ch]) this.speakerRefs[ch].off();
      if (this.audioStreamRefs[ch]) this.audioStreamRefs[ch].off();
    });
    this.speakerRefs = {};
    this.audioStreamRefs = {};

    if (this.userRef) {
      try { await this.userRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP }); } catch (e) {}
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
    this._bound = false;
    this.userId = null;
    this.callsign = '';
    this.userRef = null;

    this._showBar(false);
    console.log('[CADRadio] Cleanup complete');
  }
};
