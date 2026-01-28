/**
 * CADRadio Module — HOSCAD Radio Integration
 *
 * Self-contained 4-channel PTT radio using Firebase Realtime Database.
 * Compatible with holdenptt (holdenptt-ce145) audio format.
 *
 * Features: persistent login, auto-reconnect, browser notifications,
 * compact channel selector with single PTT.
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
  FCM_VAPID_KEY: "BO3PtS_JouQlD1pWNIzLy5s0Q6Dh1kak3Qg4vypp3KLSV1oQKwpyyzn5xFnuNmwg4_K2XO1dLKAUk9_SYNcfudk",

  // ── State ──
  channels: ['main', 'channel2', 'channel3', 'channel4'],
  channelNames: { main: 'CH1', channel2: 'CH2', channel3: 'CH3', channel4: 'CH4' },
  selectedChannel: 'main',
  txChannel: null,
  rxEnabled: { main: true, channel2: false, channel3: false, channel4: false },
  rxActivity: { main: false, channel2: false, channel3: false, channel4: false },
  activeSpeakers: {},
  isTransmitting: false,
  _ready: false,
  _bound: false,
  _reconnecting: false,

  // ── Firebase refs ──
  firebaseApp: null,
  firebaseAuth: null,
  firebaseDb: null,
  userId: null,
  callsign: '',
  speakerRefs: {},
  audioStreamRefs: {},
  userRef: null,
  _rootUserRef: null,
  _connectedRef: null,
  _visibilityHandler: null,

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
  _silentAudio: null,
  _mediaSessionActive: false,
  _wakeLock: null,
  _wakeLockIdleTimer: null,
  _heartbeatInterval: null,
  _heartbeatVisHandler: null,
  HEARTBEAT_INTERVAL_MS: 30000,

  // ── FCM Push Notifications ──
  _fcmMessaging: null,
  _swRegistration: null,
  _fcmToken: null,

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
      this._initFCM();
      console.log('[CADRadio] Firebase initialized');
    } catch (err) {
      console.error('[CADRadio] Firebase init failed:', err);
    }
  },

  // ============================================================
  // SESSION PERSISTENCE
  // ============================================================
  _saveSession() {
    try {
      localStorage.setItem('cadradio_callsign', this.callsign);
    } catch (e) {}
  },

  _loadSession() {
    try {
      return localStorage.getItem('cadradio_callsign') || '';
    } catch (e) { return ''; }
  },

  _clearSession() {
    try {
      localStorage.removeItem('cadradio_callsign');
    } catch (e) {}
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
        heartbeat: firebase.database.ServerValue.TIMESTAMP,
        kicked: false
      });
      this.userRef.onDisconnect().update({
        online: false,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });

      // Also write to root-level users/ path so the Cloud Function (onAlert)
      // can find this user's FCM token and channel
      this._rootUserRef = this.firebaseDb.ref('users/' + this.userId);
      await this._rootUserRef.set({
        displayName: callsign,
        online: true,
        channel: 'main',
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });
      this._rootUserRef.onDisconnect().update({
        online: false,
        lastSeen: firebase.database.ServerValue.TIMESTAMP
      });

      this._ready = true;
      this.joinAllChannels();
      this._startHeartbeat();
      this._listenConnection();
      this._listenVisibility();
      this._requestWakeLock();
      this._saveSession();
      this._requestNotificationPermission();
      this._registerFCMToken();
      this._setupForegroundFCM();
      this._showBar(true);
      console.log('[CADRadio] Logged in as', callsign, '| uid:', this.userId);
      return true;
    } catch (err) {
      console.error('[CADRadio] Login failed:', err);
      return false;
    }
  },

  // ============================================================
  // AUTO-RECONNECT — called on page load if saved session exists
  // ============================================================
  async autoReconnect() {
    const saved = this._loadSession();
    if (!saved) return false;

    this.init();
    this._setTxStatus('RECONNECTING...', 'reconnecting');
    const result = await this.login(saved, this.ROOM_PASSWORD);
    if (result) {
      this._setTxStatus('STANDBY', '');
      console.log('[CADRadio] Auto-reconnected as', saved);
    } else {
      this._clearSession();
      this._setTxStatus('RECONNECT FAILED', '');
      setTimeout(() => this._setTxStatus('', ''), 3000);
    }
    return result;
  },

  // ============================================================
  // CONNECTION STATE LISTENER
  // ============================================================
  _listenConnection() {
    if (this._connectedRef) this._connectedRef.off();
    this._connectedRef = this.firebaseDb.ref('.info/connected');
    this._connectedRef.on('value', (snap) => {
      if (snap.val() === true) {
        if (this._reconnecting) {
          this._reconnecting = false;
          this._setTxStatus('RECONNECTED', 'receiving');
          setTimeout(() => {
            if (!this.isTransmitting && !this._anyRxActive()) {
              this._setTxStatus('STANDBY', '');
            }
          }, 2000);
          if (this.userRef) {
            this.userRef.update({
              online: true,
              lastSeen: firebase.database.ServerValue.TIMESTAMP
            });
            this.userRef.onDisconnect().update({
              online: false,
              lastSeen: firebase.database.ServerValue.TIMESTAMP
            });
          }
          if (this._rootUserRef) {
            this._rootUserRef.update({
              online: true,
              lastSeen: firebase.database.ServerValue.TIMESTAMP
            });
            this._rootUserRef.onDisconnect().update({
              online: false,
              lastSeen: firebase.database.ServerValue.TIMESTAMP
            });
          }
          console.log('[CADRadio] Reconnected to Firebase');
        }
      } else {
        if (this._ready) {
          this._reconnecting = true;
          this._setTxStatus('RECONNECTING...', 'reconnecting');
          console.log('[CADRadio] Disconnected from Firebase');
        }
      }
    });
  },

  // ============================================================
  // VISIBILITY CHANGE — re-acquire wake lock, check connection
  // ============================================================
  _listenVisibility() {
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
    }
    this._visibilityHandler = () => {
      if (!document.hidden && this._ready) {
        this._requestWakeLock();
        if (this.audioContext && this.audioContext.state === 'suspended') {
          this.audioContext.resume();
        }
        this._writeHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  },

  // ============================================================
  // NOTIFICATIONS
  // ============================================================
  _requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((p) => {
        console.log('[CADRadio] Notification permission:', p);
      });
    }
  },

  _notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    try {
      const n = new Notification(title, {
        body: body,
        tag: 'cadradio-' + title.replace(/\s+/g, '-').toLowerCase(),
        icon: 'download.png',
        requireInteraction: false
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      setTimeout(() => n.close(), 8000);
    } catch (e) {
      console.warn('[CADRadio] Notification failed:', e);
    }
  },

  // ============================================================
  // CHANNEL SELECTION (compact radio bar)
  // ============================================================
  selectChannel(channel) {
    if (!this.channels.includes(channel)) return;
    this.selectedChannel = channel;
    // Update UI active state
    document.querySelectorAll('.ch-sel-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.ch === channel);
    });
    console.log('[CADRadio] Selected TX channel:', this.channelNames[channel]);
  },

  // ============================================================
  // BIND PTT BUTTONS — attach event listeners (not inline handlers)
  // ============================================================
  _bindButtons() {
    if (this._bound) return;
    this._bound = true;
    const self = this;

    // Desktop app: hook global PTT hotkey (F5) to selected channel
    if (window.desktopAPI && window.desktopAPI.onGlobalPTT) {
      window.desktopAPI.onGlobalPTT(function(state) {
        if (state === 'down') self._onPTTDown(self.selectedChannel, null);
        else if (state === 'up') self._onPTTUp();
      });
    }

    // PTT buttons (both .radio-tx-btn for CAD bar and .ptt-btn for standalone)
    document.querySelectorAll('.radio-tx-btn, .ptt-btn').forEach(btn => {
      const ch = btn.dataset.ch;
      // For the main PTT button (no data-ch), use selected channel
      btn.addEventListener('pointerdown', function(e) {
        e.preventDefault();
        const channel = ch || self.selectedChannel;
        self._onPTTDown(channel, this);
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
      btn.addEventListener('contextmenu', function(e) {
        e.preventDefault();
      });
    });

    // Channel selector buttons
    document.querySelectorAll('.ch-sel-btn').forEach(btn => {
      const ch = btn.dataset.ch;
      if (!ch) return;
      btn.addEventListener('click', function() {
        self.selectChannel(ch);
      });
    });

    // Tone buttons (dispatcher side)
    document.querySelectorAll('.tone-btn').forEach(btn => {
      const ch = btn.dataset.toneCh;
      if (!ch) return;
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        self.sendTone(ch);
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

    let micPromise = null;
    if (!this.localStream) {
      this._setTxStatus('MIC REQUEST...', 'transmitting');
      micPromise = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    }

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

    this._unlockAudio();

    if (this.activeSpeakers[channel] && this.activeSpeakers[channel].userId !== this.userId) {
      this._setTxStatus('CHANNEL BUSY', '');
      if (btnEl) btnEl.classList.remove('transmitting');
      setTimeout(() => {
        if (!this.isTransmitting) this._setTxStatus('STANDBY', '');
      }, 1500);
      return;
    }

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

    this.isTransmitting = true;
    this.txChannel = channel;
    ref.onDisconnect().remove();

    await this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/audioStream').remove();
    this._startCapture(channel);
    this._setTxStatus('TX: ' + this.channelNames[channel], 'transmitting');
    this._startMeter();
    this._onAudioActivity();

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

      document.querySelectorAll('.ptt-btn, .radio-tx-btn').forEach(el => {
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
        this._onAudioActivity();
        this._notify('Radio Activity — ' + this.channelNames[channel], speaker.displayName + ' is transmitting');
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
  // DISPATCH ALERT TONE (loads tone-urgent.wav, streams as PCM)
  // ============================================================
  _toneCache: null,

  async _loadToneChunks() {
    if (this._toneCache) return this._toneCache;

    const targetRate = this.SAMPLE_RATE;

    // Decode audio at browser's native sample rate
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const response = await fetch('tone-urgent.wav?v=5');
    const arrayBuf = await response.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    ctx.close().catch(() => {});

    // Use OfflineAudioContext for proper anti-aliased resampling to 16kHz
    const duration = audioBuf.duration;
    const outLen = Math.ceil(duration * targetRate);
    const offline = new OfflineAudioContext(1, outLen, targetRate);
    const src = offline.createBufferSource();
    src.buffer = audioBuf;
    src.connect(offline.destination);
    src.start(0);
    const resampled = await offline.startRendering();

    // Convert to Int16 PCM
    const floatData = resampled.getChannelData(0);
    const int16 = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Split into chunks matching CHUNK_INTERVAL
    const chunkSize = Math.floor(targetRate * (this.CHUNK_INTERVAL / 1000)) * 2;
    const chunks = [];
    const bytes = new Uint8Array(int16.buffer);

    for (let bOffset = 0; bOffset < bytes.length; bOffset += chunkSize) {
      const end = Math.min(bOffset + chunkSize, bytes.length);
      let binary = '';
      for (let i = bOffset; i < end; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      chunks.push(btoa(binary));
    }

    this._toneCache = chunks;
    console.log('[CADRadio] Tone loaded:', chunks.length, 'chunks from tone-urgent.wav (OfflineAudioContext resampled)');
    return chunks;
  },

  async sendTone(channel) {
    if (this.isTransmitting || !this._ready) {
      console.log('[CADRadio] Tone blocked: transmitting=', this.isTransmitting, 'ready=', this._ready);
      return;
    }

    this._unlockAudio();

    if (this.activeSpeakers[channel] && this.activeSpeakers[channel].userId !== this.userId) {
      this._setTxStatus('CHANNEL BUSY', '');
      setTimeout(() => {
        if (!this.isTransmitting) this._setTxStatus('STANDBY', '');
      }, 1500);
      return;
    }

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
        setTimeout(() => {
          if (!this.isTransmitting) this._setTxStatus('STANDBY', '');
        }, 1500);
        return;
      }
    } catch (err) {
      console.error('[CADRadio] Tone claim error:', err);
      this._setTxStatus('TX ERROR', '');
      return;
    }

    this.isTransmitting = true;
    this.txChannel = channel;
    ref.onDisconnect().remove();

    this._setTxStatus('TONE: ' + this.channelNames[channel], 'transmitting');
    this._onAudioActivity();

    const streamRef = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/audioStream');
    await streamRef.remove();

    let chunks;
    try {
      chunks = await this._loadToneChunks();
    } catch (err) {
      console.error('[CADRadio] Failed to load tone file:', err);
      this.isTransmitting = false;
      this.txChannel = null;
      this._setTxStatus('TONE ERROR', '');
      setTimeout(() => { if (!this.isTransmitting) this._setTxStatus('STANDBY', ''); }, 2000);
      return;
    }
    let chunkCount = 0;
    const TONE_REPEATS = 3;
    const GAP_MS = 300; // pause between repeats

    for (let rep = 0; rep < TONE_REPEATS; rep++) {
      if (!this.isTransmitting) break;
      for (const pcm of chunks) {
        if (!this.isTransmitting) break;
        chunkCount++;
        await streamRef.push({
          pcm: pcm,
          sid: this.userId,
          t: firebase.database.ServerValue.TIMESTAMP,
          n: chunkCount
        });
        await new Promise(r => setTimeout(r, this.CHUNK_INTERVAL));
      }
      // Brief silence between repeats
      if (rep < TONE_REPEATS - 1 && this.isTransmitting) {
        await new Promise(r => setTimeout(r, GAP_MS));
      }
    }

    this.isTransmitting = false;
    this.txChannel = null;
    await streamRef.remove();

    try {
      await ref.transaction(current => {
        if (current && current.userId === this.userId) return null;
        return current;
      });
      ref.onDisconnect().cancel();
    } catch (err) {
      console.error('[CADRadio] Tone release error:', err);
    }

    if (!this._anyRxActive()) {
      this._setTxStatus('STANDBY', '');
    }
    console.log('[CADRadio] Tone complete on', channel);
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
    this._startSilentAudio();
    this._setupMediaSession();
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
  // HEARTBEAT PRESENCE
  // ============================================================
  _writeHeartbeat() {
    if (this.userRef) {
      this.userRef.child('heartbeat').set(firebase.database.ServerValue.TIMESTAMP);
    }
  },

  _startHeartbeat() {
    this._stopHeartbeat();
    this._writeHeartbeat();
    this._heartbeatInterval = setInterval(() => this._writeHeartbeat(), this.HEARTBEAT_INTERVAL_MS);
    this._heartbeatVisHandler = () => {
      if (!document.hidden) this._writeHeartbeat();
    };
    document.addEventListener('visibilitychange', this._heartbeatVisHandler);
  },

  _stopHeartbeat() {
    if (this._heartbeatInterval) { clearInterval(this._heartbeatInterval); this._heartbeatInterval = null; }
    if (this._heartbeatVisHandler) {
      document.removeEventListener('visibilitychange', this._heartbeatVisHandler);
      this._heartbeatVisHandler = null;
    }
  },

  // ============================================================
  // SILENT AUDIO LOOP (keeps background alive on mobile)
  // ============================================================
  _startSilentAudio() {
    if (this._silentAudio) return;
    const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQAAAAA=';
    const el = document.createElement('audio');
    el.src = silentWav;
    el.loop = true;
    el.volume = 0.01;
    el.play().catch(() => {});
    this._silentAudio = el;
    console.log('[CADRadio] Silent audio started');
  },

  _stopSilentAudio() {
    if (this._silentAudio) {
      this._silentAudio.pause();
      this._silentAudio.removeAttribute('src');
      this._silentAudio = null;
    }
  },

  // ============================================================
  // MEDIA SESSION API (shows in OS media controls)
  // ============================================================
  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    if (this._mediaSessionActive) return;
    this._mediaSessionActive = true;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'HOSCAD Radio',
      artist: 'CH1'
    });
    navigator.mediaSession.playbackState = 'playing';
    console.log('[CADRadio] Media session set up');
  },

  _updateMediaSessionChannel(channelName) {
    if (!('mediaSession' in navigator) || !this._mediaSessionActive) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'HOSCAD Radio',
      artist: channelName
    });
  },

  // ============================================================
  // WAKE LOCK API (kept for entire radio session)
  // ============================================================
  async _requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (this._wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      console.log('[CADRadio] Wake lock acquired');
    } catch (e) {
      console.warn('[CADRadio] Wake lock failed:', e);
    }
  },

  _releaseWakeLock() {
    if (this._wakeLock) {
      this._wakeLock.release().catch(() => {});
      this._wakeLock = null;
    }
  },

  _onAudioActivity() {
    if (!this._wakeLock) this._requestWakeLock();
  },

  // ============================================================
  // FCM PUSH NOTIFICATIONS
  // ============================================================
  _initFCM() {
    try {
      if (!('PushManager' in window)) {
        console.log('[CADRadio] PushManager not supported — FCM disabled');
        return;
      }
      if (typeof firebase.messaging !== 'function') {
        console.log('[CADRadio] firebase.messaging SDK not loaded — FCM disabled');
        return;
      }
      this._fcmMessaging = this.firebaseApp.messaging();
      console.log('[CADRadio] FCM messaging initialized');
    } catch (err) {
      console.warn('[CADRadio] FCM init failed:', err);
    }
  },

  async _registerFCMToken() {
    if (!this._fcmMessaging) return;
    try {
      this._swRegistration = await navigator.serviceWorker.ready;
      const token = await this._fcmMessaging.getToken({
        vapidKey: this.FCM_VAPID_KEY,
        serviceWorkerRegistration: this._swRegistration
      });

      if (token) {
        this._fcmToken = token;
        if (this.userRef) {
          this.userRef.child('fcmToken').set(token);
        }
        if (this._rootUserRef) {
          this._rootUserRef.child('fcmToken').set(token);
        }
        // Notify external code (radio.html) that FCM token is ready
        if (typeof this.onFCMTokenReady === 'function') {
          this.onFCMTokenReady(token);
        }
        console.log('[CADRadio] FCM token registered');
      } else {
        console.warn('[CADRadio] FCM getToken returned null');
      }
    } catch (err) {
      console.warn('[CADRadio] FCM token registration failed:', err);
    }
  },

  _setupForegroundFCM() {
    if (!this._fcmMessaging) return;
    this._fcmMessaging.onMessage((payload) => {
      console.log('[CADRadio] FCM foreground message:', payload);
      const data = payload.data || {};
      const title = data.title || 'CADRadio Alert';
      const body = data.body || 'Dispatch alert received';
      this._notify(title, body);
    });
    console.log('[CADRadio] FCM foreground handler set up');
  },

  async _removeFCMToken() {
    if (!this._fcmMessaging || !this._fcmToken) return;
    try {
      if (this.userRef) {
        this.userRef.child('fcmToken').remove();
      }
      if (this._rootUserRef) {
        this._rootUserRef.child('fcmToken').remove();
      }
      await this._fcmMessaging.deleteToken();
      this._fcmToken = null;
      console.log('[CADRadio] FCM token removed');
    } catch (err) {
      console.warn('[CADRadio] FCM token removal failed:', err);
    }
  },

  // ============================================================
  // CLEANUP (explicit logout)
  // ============================================================
  async cleanup() {
    if (this.isTransmitting) await this._stopTX();
    this._stopCapture();
    this._stopMeter();
    this._stopHeartbeat();
    this._stopSilentAudio();
    this._releaseWakeLock();
    this._mediaSessionActive = false;

    if (this._connectedRef) { this._connectedRef.off(); this._connectedRef = null; }

    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    this.channels.forEach(ch => {
      if (this.speakerRefs[ch]) this.speakerRefs[ch].off();
      if (this.audioStreamRefs[ch]) this.audioStreamRefs[ch].off();
    });
    this.speakerRefs = {};
    this.audioStreamRefs = {};

    if (this.userRef) {
      try { await this.userRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP }); } catch (e) {}
    }

    if (this._rootUserRef) {
      try { await this._rootUserRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP }); } catch (e) {}
      this._rootUserRef = null;
    }

    await this._removeFCMToken();

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
    this._reconnecting = false;
    this.userId = null;
    this.callsign = '';
    this.userRef = null;

    this._clearSession();

    this._showBar(false);
    console.log('[CADRadio] Cleanup complete');
  }
};
