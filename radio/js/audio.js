// ========================================
// PTT AUDIO MODULE (Firebase PCM Streaming)
// ========================================

const PTTAudio = {
    localStream: null,
    isTransmitting: false,
    currentSpeaker: null,
    speakerRef: null,
    audioStreamRef: null,
    audioContext: null,
    audioUnlocked: false,
    rogerContext: null,
    captureNode: null,
    captureSource: null,
    _captureCtx: null,
    chunkBuffer: [],
    sendInterval: null,
    pttLocked: false,
    _suppressSpeakerMsg: false,

    _silentAudio: null,
    _mediaSessionActive: false,

    SAMPLE_RATE: 16000,
    CHUNK_INTERVAL: 200,
    _playbackTime: 0,
    _toggleMode: false,
    _toggleActive: false,
    _analyser: null,
    _meterRAF: null,
    _gainNode: null,

    init() {
        console.log('[Audio] Initializing...');

        const pttBtn = document.getElementById('ptt-btn');

        // Hold mode (mouse)
        pttBtn.addEventListener('mousedown', (e) => { e.preventDefault(); this.handlePTTPress(); });
        pttBtn.addEventListener('mouseup', (e) => { e.preventDefault(); this.handlePTTRelease(); });
        pttBtn.addEventListener('mouseleave', () => { if (this.isTransmitting && !this._toggleMode) this.stopTransmit(); });

        // Hold mode (touch)
        pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.handlePTTPress(); });
        pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); this.handlePTTRelease(); });
        pttBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); if (this.isTransmitting && !this._toggleMode) this.stopTransmit(); });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat && !this.isInputFocused()) {
                e.preventDefault();
                this.handlePTTPress();
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space' && !this.isInputFocused()) {
                e.preventDefault();
                this.handlePTTRelease();
            }
        });

        // Toggle mode switch
        document.getElementById('ptt-toggle-mode').addEventListener('change', (e) => {
            this._toggleMode = e.target.checked;
            const hint = document.querySelector('.ptt-hint');
            if (hint) hint.textContent = this._toggleMode ? 'Tap to toggle' : 'Hold SPACE or Click';
            if (this.isTransmitting && !this._toggleMode) this.stopTransmit();
        });

        // Volume slider
        const volSlider = document.getElementById('volume-slider');
        const volValue = document.getElementById('volume-value');
        volSlider.addEventListener('input', (e) => {
            const vol = parseInt(e.target.value);
            volValue.textContent = vol + '%';
            if (this._gainNode) this._gainNode.gain.value = vol / 100;
        });
    },

    handlePTTPress() {
        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(30);

        if (this._toggleMode) {
            if (this.isTransmitting) {
                this.stopTransmit();
            } else {
                this.startTransmit();
            }
        } else {
            this.startTransmit();
        }
    },

    handlePTTRelease() {
        if (!this._toggleMode) {
            if (navigator.vibrate) navigator.vibrate(15);
            this.stopTransmit();
        }
    },

    isInputFocused() {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    },

    unlockAudio() {
        if (this.audioUnlocked) return;
        this.audioUnlocked = true;
        console.log('[Audio] Unlocking audio playback');
        this.getAudioContext();
        const ctx = this.audioContext;
        if (ctx.state === 'suspended') ctx.resume();
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);

        // Start silent audio and media session (inside user gesture)
        this.startSilentAudio();
        this.setupMediaSession();
    },

    getAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            // Create gain node for volume control
            this._gainNode = this.audioContext.createGain();
            this._gainNode.gain.value = parseInt(document.getElementById('volume-slider').value) / 100;
            this._gainNode.connect(this.audioContext.destination);
        }
        return this.audioContext;
    },

    async requestMicrophone() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });
            console.log('[Audio] Microphone granted');
            return true;
        } catch (error) {
            console.error('[Audio] Mic denied:', error);
            Chat.addSystemMessage('Microphone access denied. PTT will not work.');
            return false;
        }
    },

    async joinChannel(channel) {
        console.log('[Audio] Joining channel:', channel);

        if (!this.localStream) await this.requestMicrophone();

        this.speakerRef = database.ref(`channels/${channel}/activeSpeaker`);
        this.audioStreamRef = database.ref(`channels/${channel}/audioStream`);

        // Clear any stale speaker data on join
        const snap = await this.speakerRef.once('value');
        const stale = snap.val();
        if (stale) {
            // Check if that user is actually still online
            const userSnap = await database.ref(`users/${stale.userId}/online`).once('value');
            const isOnline = userSnap.val();
            // Also check timestamp - if older than 30 seconds, consider stale
            const age = stale.timestamp ? (Date.now() - stale.timestamp) : Infinity;
            if (!isOnline || age > 30000) {
                console.log('[Audio] Clearing stale speaker (online:', isOnline, 'age:', age, 'ms)');
                await this.speakerRef.remove();
            }
        }

        // Suppress the first speaker change message (stale data on join)
        this._suppressSpeakerMsg = true;

        // Listen for speaker changes
        this.speakerRef.on('value', (s) => this.handleSpeakerChange(s.val()));

        // Listen for audio from others — DO NOT remove in listener (sender cleans up)
        this.audioStreamRef.on('child_added', (s) => {
            const data = s.val();
            if (data && data.sid !== Auth.getUserId()) {
                this.receiveAudioChunk(data.pcm);
            }
        });

        // Update media session with new channel name
        this.updateMediaSessionChannel(Channels.getChannelName(channel));

        Chat.addSystemMessage('Audio system ready. Tap PTT button once to enable sound.');
    },

    async leaveChannel(channel) {
        if (this.isTransmitting) await this.stopTransmit();
        if (this.speakerRef) { this.speakerRef.off(); this.speakerRef = null; }
        if (this.audioStreamRef) { this.audioStreamRef.off(); this.audioStreamRef = null; }
    },

    async switchChannel(oldCh, newCh) {
        await this.leaveChannel(oldCh);
        await this.joinChannel(newCh);
    },

    // ==================
    // TRANSMIT
    // ==================
    async startTransmit() {
        if (this.isTransmitting || this.pttLocked) return;

        if (!this.localStream) {
            this.pttLocked = true;
            const ok = await this.requestMicrophone();
            this.pttLocked = false;
            if (!ok) return;
        }

        const user = Auth.getUser();
        if (!user) return;

        this.unlockAudio();

        // Check if channel is busy
        if (this.currentSpeaker && this.currentSpeaker.userId !== Auth.getUserId()) {
            return;
        }

        const channel = Channels.getCurrentChannel();
        const ref = database.ref(`channels/${channel}/activeSpeaker`);

        try {
            const result = await ref.transaction((current) => {
                if (!current || current.userId === Auth.getUserId()) {
                    return {
                        userId: Auth.getUserId(),
                        displayName: user.displayName,
                        timestamp: firebase.database.ServerValue.TIMESTAMP
                    };
                }
                return undefined;
            });
            if (!result.committed) return;
        } catch (err) {
            console.error('[Audio] TX claim error:', err);
            return;
        }

        this.isTransmitting = true;
        ref.onDisconnect().remove();

        // Clear old audio stream data before starting
        await database.ref(`channels/${channel}/audioStream`).remove();

        this.startCapture(channel);
        document.getElementById('ptt-btn').classList.add('active');
        document.getElementById('audio-meter').classList.remove('hidden');

        // Wake lock for transmit
        if (typeof App !== 'undefined') App.onAudioActivity();

        if (typeof Recording !== 'undefined') Recording.onTransmitStart();
        console.log('[Audio] TX started');
    },

    startCapture(channel) {
        const streamRef = database.ref(`channels/${channel}/audioStream`);
        const senderId = Auth.getUserId();

        // Use browser's native sample rate for capture (don't force 8kHz — many browsers reject it)
        const captureCtx = new (window.AudioContext || window.webkitAudioContext)();
        const nativeRate = captureCtx.sampleRate;
        const targetRate = this.SAMPLE_RATE;

        console.log('[Audio] Capture context sample rate:', nativeRate, '-> downsampling to', targetRate);

        const source = captureCtx.createMediaStreamSource(this.localStream);

        // Analyser for level meter
        const analyser = captureCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        this._analyser = analyser;
        this.startMeter();

        const processor = captureCtx.createScriptProcessor(4096, 1, 1);

        this.chunkBuffer = [];
        let chunkCount = 0;

        processor.onaudioprocess = (e) => {
            if (!this.isTransmitting) return;

            const input = e.inputBuffer.getChannelData(0);

            // Downsample from native rate to target rate using linear interpolation
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

            // Base64 encode
            const bytes = new Uint8Array(int16.buffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            this.chunkBuffer.push(btoa(binary));
        };

        source.connect(processor);
        // Connect through a silent gain node — processor must be connected to
        // destination to stay alive, but we don't want mic audio on speakers
        const silencer = captureCtx.createGain();
        silencer.gain.value = 0;
        processor.connect(silencer);
        silencer.connect(captureCtx.destination);

        this.captureSource = source;
        this.captureNode = processor;
        this._captureCtx = captureCtx;

        // Periodically send chunks to Firebase
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

    stopCapture() {
        if (this.sendInterval) { clearInterval(this.sendInterval); this.sendInterval = null; }
        if (this.captureNode) { this.captureNode.disconnect(); this.captureNode = null; }
        if (this.captureSource) { this.captureSource.disconnect(); this.captureSource = null; }
        if (this._captureCtx) { this._captureCtx.close().catch(() => {}); this._captureCtx = null; }
        this.chunkBuffer = [];
        this.stopMeter();
    },

    startMeter() {
        const fill = document.getElementById('meter-fill');
        const analyser = this._analyser;
        if (!analyser || !fill) return;

        const data = new Uint8Array(analyser.frequencyBinCount);
        const update = () => {
            if (!this._analyser) return;
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const avg = sum / data.length;
            const pct = Math.min(100, (avg / 128) * 100);
            fill.style.width = pct + '%';
            fill.className = 'meter-fill' + (pct > 80 ? ' clipping' : pct > 55 ? ' hot' : '');
            this._meterRAF = requestAnimationFrame(update);
        };
        this._meterRAF = requestAnimationFrame(update);
    },

    stopMeter() {
        if (this._meterRAF) { cancelAnimationFrame(this._meterRAF); this._meterRAF = null; }
        this._analyser = null;
        const meter = document.getElementById('audio-meter');
        if (meter) meter.classList.add('hidden');
        const fill = document.getElementById('meter-fill');
        if (fill) fill.style.width = '0%';
    },

    async stopTransmit() {
        if (!this.isTransmitting) return;
        console.log('[Audio] TX stopped');
        this.isTransmitting = false;

        this.stopCapture();

        const channel = Channels.getCurrentChannel();

        // Clean up audio stream data
        database.ref(`channels/${channel}/audioStream`).remove();

        // Release speaker
        const ref = database.ref(`channels/${channel}/activeSpeaker`);
        try {
            await ref.transaction((current) => {
                if (current && current.userId === Auth.getUserId()) return null;
                return current;
            });
            ref.onDisconnect().cancel();
        } catch (err) {
            console.error('[Audio] TX release error:', err);
        }

        document.getElementById('ptt-btn').classList.remove('active');
        document.getElementById('audio-meter').classList.add('hidden');
        if (typeof Recording !== 'undefined') Recording.onTransmitStop();
    },

    // ==================
    // RECEIVE & PLAYBACK
    // ==================
    receiveAudioChunk(pcmData) {
        if (!pcmData) return;

        const ctx = this.getAudioContext();
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
                console.error('[Audio] Decode error:', err);
            }
        }

        if (allSamples.length === 0) return;

        const float32 = new Float32Array(allSamples);
        this.schedulePlayback(float32);
    },

    schedulePlayback(samples) {
        const ctx = this.audioContext;
        if (!ctx) return;

        const buffer = ctx.createBuffer(1, samples.length, this.SAMPLE_RATE);
        buffer.getChannelData(0).set(samples);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this._gainNode || ctx.destination);

        // Schedule gapless playback, but reset if too far ahead (prevents
        // audio accumulating into the future during Firebase delivery bursts)
        const now = ctx.currentTime;
        if (this._playbackTime < now || this._playbackTime > now + 0.5) {
            this._playbackTime = now;
        }
        source.start(this._playbackTime);
        this._playbackTime += buffer.duration;
    },

    // ==================
    // ROGER BEEP
    // ==================
    playRogerBeep() {
        if (!this.rogerContext) {
            this.rogerContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        const ctx = this.rogerContext;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;

        const osc1 = ctx.createOscillator();
        const g1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(1200, now);
        osc1.frequency.exponentialRampToValueAtTime(800, now + 0.08);
        osc1.connect(g1); g1.connect(ctx.destination);
        g1.gain.setValueAtTime(0.25, now);
        g1.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc1.start(now); osc1.stop(now + 0.12);

        const osc2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1400, now + 0.05);
        osc2.frequency.exponentialRampToValueAtTime(1000, now + 0.15);
        osc2.connect(g2); g2.connect(ctx.destination);
        g2.gain.setValueAtTime(0.2, now + 0.05);
        g2.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        osc2.start(now + 0.05); osc2.stop(now + 0.18);
    },

    // ==================
    // SILENT AUDIO & MEDIA SESSION
    // ==================
    startSilentAudio() {
        if (this._silentAudio) return;
        // Tiny silent WAV (1 sample, 1 channel, 8-bit, 8000Hz)
        const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQAAAAA=';
        const el = document.createElement('audio');
        el.src = silentWav;
        el.loop = true;
        el.volume = 0.01;
        el.play().catch(() => {});
        this._silentAudio = el;
        console.log('[Audio] Silent audio started');
    },

    stopSilentAudio() {
        if (this._silentAudio) {
            this._silentAudio.pause();
            this._silentAudio.removeAttribute('src');
            this._silentAudio = null;
            console.log('[Audio] Silent audio stopped');
        }
    },

    setupMediaSession() {
        if (!('mediaSession' in navigator)) return;
        if (this._mediaSessionActive) return;
        this._mediaSessionActive = true;
        const channelName = Channels.getChannelName(Channels.getCurrentChannel());
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Holden PTT',
            artist: channelName
        });
        navigator.mediaSession.playbackState = 'playing';
        console.log('[Audio] Media session set up');
    },

    updateMediaSessionState(state) {
        if (!('mediaSession' in navigator) || !this._mediaSessionActive) return;
        navigator.mediaSession.playbackState = state;
    },

    updateMediaSessionChannel(channelName) {
        if (!('mediaSession' in navigator) || !this._mediaSessionActive) return;
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Holden PTT',
            artist: channelName
        });
    },

    // ==================
    // TX NOTIFICATION
    // ==================
    showTXNotification(speakerName) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const channelName = Channels.getChannelName(Channels.getCurrentChannel());
        const n = new Notification('Holden PTT', {
            body: `${speakerName} is transmitting on ${channelName}`,
            tag: 'ptt-tx'
        });
        setTimeout(() => n.close(), 5000);
    },

    // ==================
    // SPEAKER STATUS
    // ==================
    handleSpeakerChange(speaker) {
        const prev = this.currentSpeaker;
        this.currentSpeaker = speaker;
        const ind = document.getElementById('tx-indicator');
        const txt = ind.querySelector('.tx-text');
        const info = document.getElementById('speaker-info');

        if (speaker) {
            if (speaker.userId === Auth.getUserId()) {
                ind.className = 'tx-indicator transmitting';
                txt.textContent = 'TRANSMITTING';
                info.textContent = '';
            } else {
                ind.className = 'tx-indicator receiving';
                txt.textContent = 'RECEIVING';
                info.textContent = `${speaker.displayName} is talking`;
                Channels.markSpeaking(speaker.userId, true);
                this._playbackTime = 0; // Reset playback schedule for new speaker

                // Show TX notification when receiving in background
                if (document.hidden) {
                    this.showTXNotification(speaker.displayName);
                }
            }

            // Wake lock + media session for active audio
            if (typeof App !== 'undefined') App.onAudioActivity();
            this.updateMediaSessionState('playing');

            // Only show system message for new transmissions, not on initial join
            if (typeof Chat !== 'undefined' && speaker.userId !== Auth.getUserId() && !this._suppressSpeakerMsg) {
                Chat.addSystemMessage(`${speaker.displayName} is transmitting`);
            }
            this._suppressSpeakerMsg = false;
        } else {
            if (prev && prev.userId !== Auth.getUserId() && !this._suppressSpeakerMsg) {
                this.playRogerBeep();
            }
            this._suppressSpeakerMsg = false;
            ind.className = 'tx-indicator';
            txt.textContent = 'STANDBY';
            info.textContent = '';
            document.querySelectorAll('#member-list li.speaking').forEach(li => li.classList.remove('speaking'));

            // Audio idle - release wake lock after timeout
            if (typeof App !== 'undefined') App.onAudioIdle();
            this.updateMediaSessionState('paused');
        }
    },

    // ==================
    // CLEANUP
    // ==================
    async cleanup() {
        if (this.isTransmitting) await this.stopTransmit();
        this.stopCapture();
        this.stopSilentAudio();
        this._mediaSessionActive = false;
        if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
        if (this.speakerRef) { this.speakerRef.off(); this.speakerRef = null; }
        if (this.audioStreamRef) { this.audioStreamRef.off(); this.audioStreamRef = null; }
        if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
        this._playbackTime = 0;
    }
};
