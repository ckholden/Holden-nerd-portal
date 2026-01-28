/**
 * CADRadio Module — HOSCAD Radio Integration
 *
 * Self-contained 4-channel PTT radio using Firebase Realtime Database.
 * Compatible with holdenptt (holdenptt-ce145) audio format.
 *
 * Features: persistent login, auto-reconnect, browser notifications,
 * radio text messaging, two-tone dispatch alerts.
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

  // ── Radio Messaging ──
  _radioMsgRef: null,
  _lastRadioMsgKey: null,
  _radioMsgListener: null,

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
      this._listenRadioMessages();
      this._requestWakeLock();
      this._saveSession();
      this._requestNotificationPermission();
      this._registerFCMToken();
      this._setupForegroundFCM();
      this._listenAlertTap();
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
          // Re-set presence on both paths
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
        // Re-acquire wake lock (browsers release it when tab hides)
        this._requestWakeLock();
        // Resume audio context if suspended
        if (this.audioContext && this.audioContext.state === 'suspended') {
          this.audioContext.resume();
        }
        // Write heartbeat immediately
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
    if (!document.hidden) return; // Only notify when tab is backgrounded
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
      // Auto-close after 8 seconds
      setTimeout(() => n.close(), 8000);
    } catch (e) {
      console.warn('[CADRadio] Notification failed:', e);
    }
  },

  // ============================================================
  // BIND PTT BUTTONS — attach event listeners (not inline handlers)
  // ============================================================
  _bindButtons() {
    if (this._bound) return;
    this._bound = true;
    const self = this;

    // Desktop app: hook global PTT hotkey (F5) to CH1
    if (window.desktopAPI && window.desktopAPI.onGlobalPTT) {
      window.desktopAPI.onGlobalPTT(function(state) {
        if (state === 'down') self._onPTTDown('main', null);
        else if (state === 'up') self._onPTTUp();
      });
    }

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

    // Tone buttons
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
        this._onAudioActivity();
        // Notify on tone reception (speaker change indicates activity)
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
  // TWO-TONE DISPATCH ALERT
  // ============================================================
  _generateTwoTone() {
    // Motorola two-tone sequential paging pattern (~7.8s total)
    const rate = this.SAMPLE_RATE;
    const vol = 0.45;
    const fadeMs = 50;
    const fadeSamples = Math.floor(rate * fadeMs / 1000);

    const segments = [
      { type: 'warble', freqA: 750, freqB: 1050, altRate: 12, dur: 2.0, vol: vol },
      { type: 'silence', dur: 0.3 },
      { type: 'tone', freq: 853.2, dur: 1.0, vol: vol, fade: true },
      { type: 'tone', freq: 960,   dur: 1.0, vol: vol, fade: true },
      { type: 'silence', dur: 0.4 },
      { type: 'tone', freq: 853.2, dur: 1.0, vol: vol, fade: true },
      { type: 'tone', freq: 960,   dur: 1.0, vol: vol, fade: true },
      { type: 'silence', dur: 0.3 },
      { type: 'tone', freq: 1000,  dur: 0.8, vol: vol * 0.85, fade: true }
    ];

    let totalDur = 0;
    for (const seg of segments) totalDur += seg.dur;
    const totalSamples = Math.ceil(rate * totalDur);
    const int16 = new Int16Array(totalSamples);

    let offset = 0;
    for (const seg of segments) {
      const segSamples = Math.floor(rate * seg.dur);

      if (seg.type === 'silence') {
        offset += segSamples;
        continue;
      }

      if (seg.type === 'warble') {
        const halfPeriod = rate / (seg.altRate * 2);
        for (let i = 0; i < segSamples; i++) {
          const t = i / rate;
          const cycle = Math.floor(i / halfPeriod);
          const freq = (cycle % 2 === 0) ? seg.freqA : seg.freqB;
          const sample = Math.sin(2 * Math.PI * freq * t) * seg.vol;
          const idx = offset + i;
          if (idx < totalSamples) {
            int16[idx] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
          }
        }
        offset += segSamples;
        continue;
      }

      if (seg.type === 'tone') {
        for (let i = 0; i < segSamples; i++) {
          const t = i / rate;
          let gain = seg.vol;
          if (seg.fade && i > segSamples - fadeSamples) {
            gain *= (segSamples - i) / fadeSamples;
          }
          const sample = Math.sin(2 * Math.PI * seg.freq * t) * gain;
          const idx = offset + i;
          if (idx < totalSamples) {
            int16[idx] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
          }
        }
        offset += segSamples;
        continue;
      }
    }

    const chunkSize = Math.floor(rate * (this.CHUNK_INTERVAL / 1000)) * 2;
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

    return chunks;
  },

  async sendTone(channel) {
    if (this.isTransmitting || !this._ready) {
      console.log('[CADRadio] Tone blocked: transmitting=', this.isTransmitting, 'ready=', this._ready);
      return;
    }

    this._unlockAudio();

    // Check channel busy
    if (this.activeSpeakers[channel] && this.activeSpeakers[channel].userId !== this.userId) {
      this._setTxStatus('CHANNEL BUSY', '');
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

    // Disable tone buttons during playback
    document.querySelectorAll('.tone-btn').forEach(b => b.disabled = true);

    const streamRef = this.firebaseDb.ref(this.DB_PREFIX + 'channels/' + channel + '/audioStream');
    await streamRef.remove();

    // Generate tone PCM chunks
    const chunks = this._generateTwoTone();
    let chunkCount = 0;

    // Push chunks at CHUNK_INTERVAL to match real-time playback
    // Tone is NOT played locally — dispatcher should not hear their own tone
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

    // Release channel
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

    // Re-enable tone buttons
    document.querySelectorAll('.tone-btn').forEach(b => b.disabled = false);

    if (!this._anyRxActive()) {
      this._setTxStatus('STANDBY', '');
    }
    console.log('[CADRadio] Tone complete on', channel);
  },

  // ============================================================
  // RADIO TEXT MESSAGING
  // ============================================================
  sendRadioMessage(text) {
    if (!this._ready || !text || !text.trim()) return null;
    const msgRef = this.firebaseDb.ref(this.DB_PREFIX + 'radioMessages').push({
      from: this.callsign,
      fromUserId: this.userId,
      text: text.trim(),
      timestamp: firebase.database.ServerValue.TIMESTAMP,
      reply: null
    });
    console.log('[CADRadio] Sent radio message:', text.trim());
    return msgRef.key;
  },

  replyRadioMessage(messageKey, replyText) {
    if (!this._ready || !messageKey || !replyText) return;
    this.firebaseDb.ref(this.DB_PREFIX + 'radioMessages/' + messageKey).update({
      reply: replyText.trim(),
      replyFrom: this.callsign,
      replyTimestamp: firebase.database.ServerValue.TIMESTAMP
    });
    console.log('[CADRadio] Replied to', messageKey, ':', replyText.trim());
  },

  _listenRadioMessages() {
    if (this._radioMsgRef) this._radioMsgRef.off();

    // Listen to last 20 messages, ordered by timestamp
    this._radioMsgRef = this.firebaseDb.ref(this.DB_PREFIX + 'radioMessages')
      .orderByChild('timestamp')
      .limitToLast(20);

    // Collect existing keys during initial load, then treat anything
    // not in that set as a genuinely new message
    const existingKeys = new Set();
    let initialLoadDone = false;

    this._radioMsgRef.once('value', (snapshot) => {
      snapshot.forEach((child) => {
        existingKeys.add(child.key);
        // Track the last key from existing data
        this._lastRadioMsgKey = child.key;
      });
      initialLoadDone = true;
    });

    // New messages
    this._radioMsgRef.on('child_added', (snap) => {
      const msg = snap.val();
      if (!msg) return;

      // Always track the latest key
      this._lastRadioMsgKey = snap.key;

      // Skip messages that were already present at startup
      if (!initialLoadDone || existingKeys.has(snap.key)) return;

      // Notify if message is from someone else
      if (msg.fromUserId !== this.userId) {
        this._notify('Radio Message — ' + msg.from, msg.text);
      }

      // Dispatch DOM event for app.js or radio.html to handle
      document.dispatchEvent(new CustomEvent('radioMessageReceived', {
        detail: { key: snap.key, ...msg }
      }));
    });

    // Message updates (replies)
    this._radioMsgRef.on('child_changed', (snap) => {
      const msg = snap.val();
      if (!msg) return;

      // Notify on reply if the original message was ours
      if (msg.reply && msg.replyFrom && msg.fromUserId === this.userId) {
        this._notify('Radio Reply — ' + msg.replyFrom, msg.reply);
      }

      document.dispatchEvent(new CustomEvent('radioMessageUpdated', {
        detail: { key: snap.key, ...msg }
      }));
    });
  },

  getLastRadioMsgKey() {
    return this._lastRadioMsgKey;
  },

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
    if (this._wakeLock) return; // Already held
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
    // Wake lock is held for entire session, no idle timer needed
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
      // Get the existing SW registration (registered by radio.html or index.html)
      this._swRegistration = await navigator.serviceWorker.ready;

      const token = await this._fcmMessaging.getToken({
        vapidKey: this.FCM_VAPID_KEY,
        serviceWorkerRegistration: this._swRegistration
      });

      if (token) {
        this._fcmToken = token;
        // Store token under cadradio/users/{uid}/fcmToken
        if (this.userRef) {
          this.userRef.child('fcmToken').set(token);
        }
        // Store token under root users/{uid}/fcmToken for the Cloud Function
        if (this._rootUserRef) {
          this._rootUserRef.child('fcmToken').set(token);
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
    // Suppress duplicate notifications when app is in foreground —
    // the SW push handler shows them when backgrounded, so we just
    // log and optionally trigger the two-tone locally here.
    this._fcmMessaging.onMessage((payload) => {
      console.log('[CADRadio] FCM foreground message:', payload);
      const data = payload.data || {};
      const channel = data.channel || '';
      const title = data.title || 'CADRadio Alert';
      const body = data.body || channel || 'Dispatch alert received';

      // Show a local notification only if document is hidden
      // (foreground = visible, no need to duplicate)
      this._notify(title, body);

      // Dispatch event so radio.html can react (e.g., play two-tone)
      document.dispatchEvent(new CustomEvent('fcmAlertReceived', {
        detail: { channel: channel, title: title, body: body }
      }));
    });
    console.log('[CADRadio] FCM foreground handler set up');
  },

  async _removeFCMToken() {
    if (!this._fcmMessaging || !this._fcmToken) return;
    try {
      // Remove token from cadradio/users/{uid}
      if (this.userRef) {
        this.userRef.child('fcmToken').remove();
      }
      // Remove token from root users/{uid}
      if (this._rootUserRef) {
        this._rootUserRef.child('fcmToken').remove();
      }
      // Delete the token from FCM
      await this._fcmMessaging.deleteToken();
      this._fcmToken = null;
      console.log('[CADRadio] FCM token removed');
    } catch (err) {
      console.warn('[CADRadio] FCM token removal failed:', err);
    }
  },

  // ============================================================
  // ALERT_TAP HANDLER (from SW notification click)
  // ============================================================
  _listenAlertTap() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'ALERT_TAP') {
        console.log('[CADRadio] ALERT_TAP received, channel:', event.data.channel);
        // Unlock audio and play two-tone on the tapped channel
        this._unlockAudio();
        const channel = event.data.channel || 'main';
        // Play the tone locally so user hears the alert
        this._playToneFromChunks(this._generateTwoTone());
      }
    });
  },

  _playToneFromChunks(chunks) {
    const ctx = this._getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();

    const allSamples = [];
    for (const chunk of chunks) {
      try {
        const binary = atob(chunk);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const int16 = new Int16Array(bytes.buffer);
        for (let i = 0; i < int16.length; i++) {
          allSamples.push(int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF));
        }
      } catch (e) {}
    }
    if (allSamples.length === 0) return;

    const buffer = ctx.createBuffer(1, allSamples.length, this.SAMPLE_RATE);
    buffer.getChannelData(0).set(new Float32Array(allSamples));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.start(ctx.currentTime);
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

    // Remove connection listener
    if (this._connectedRef) { this._connectedRef.off(); this._connectedRef = null; }

    // Remove visibility listener
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    // Remove radio message listener
    if (this._radioMsgRef) { this._radioMsgRef.off(); this._radioMsgRef = null; }

    this.channels.forEach(ch => {
      if (this.speakerRefs[ch]) this.speakerRefs[ch].off();
      if (this.audioStreamRefs[ch]) this.audioStreamRefs[ch].off();
    });
    this.speakerRefs = {};
    this.audioStreamRefs = {};

    if (this.userRef) {
      try { await this.userRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP }); } catch (e) {}
    }

    // Clean up root-level user ref
    if (this._rootUserRef) {
      try { await this._rootUserRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP }); } catch (e) {}
      this._rootUserRef = null;
    }

    // Remove FCM token before sign-out
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
    this._lastRadioMsgKey = null;

    // Clear saved session on explicit logout
    this._clearSession();

    this._showBar(false);
    console.log('[CADRadio] Cleanup complete');
  }
};
