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
    playQueue: [],
    isPlaying: false,
    pttLocked: false,
    _suppressSpeakerMsg: false,

    SAMPLE_RATE: 8000,
    CHUNK_INTERVAL: 250,

    init() {
        console.log('[Audio] Initializing...');

        const pttBtn = document.getElementById('ptt-btn');

        pttBtn.addEventListener('mousedown', (e) => { e.preventDefault(); this.startTransmit(); });
        pttBtn.addEventListener('mouseup', (e) => { e.preventDefault(); this.stopTransmit(); });
        pttBtn.addEventListener('mouseleave', () => { if (this.isTransmitting) this.stopTransmit(); });

        pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.startTransmit(); });
        pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); this.stopTransmit(); });
        pttBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); if (this.isTransmitting) this.stopTransmit(); });

        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat && !this.isInputFocused()) {
                e.preventDefault();
                this.startTransmit();
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space' && !this.isInputFocused()) {
                e.preventDefault();
                this.stopTransmit();
            }
        });
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
    },

    getAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
        const processor = captureCtx.createScriptProcessor(4096, 1, 1);

        this.chunkBuffer = [];
        let chunkCount = 0;

        processor.onaudioprocess = (e) => {
            if (!this.isTransmitting) return;

            const input = e.inputBuffer.getChannelData(0);

            // Downsample from native rate to target rate
            const ratio = nativeRate / targetRate;
            const downLen = Math.floor(input.length / ratio);
            const int16 = new Int16Array(downLen);
            for (let i = 0; i < downLen; i++) {
                const srcIdx = Math.floor(i * ratio);
                const s = Math.max(-1, Math.min(1, input[srcIdx]));
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
        processor.connect(captureCtx.destination);

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

        for (const chunk of chunks) {
            try {
                const binary = atob(chunk);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                const int16 = new Int16Array(bytes.buffer);

                const float32 = new Float32Array(int16.length);
                for (let i = 0; i < int16.length; i++) {
                    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
                }

                this.playQueue.push(float32);
            } catch (err) {
                console.error('[Audio] Decode error:', err);
            }
        }

        if (!this.isPlaying) this.playNextChunk();
    },

    playNextChunk() {
        if (this.playQueue.length === 0) {
            this.isPlaying = false;
            return;
        }
        this.isPlaying = true;
        const samples = this.playQueue.shift();

        const ctx = this.audioContext;
        if (!ctx) { this.isPlaying = false; return; }

        const buffer = ctx.createBuffer(1, samples.length, this.SAMPLE_RATE);
        buffer.getChannelData(0).set(samples);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => this.playNextChunk();
        source.start(0);
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
            }
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
        }
    },

    // ==================
    // CLEANUP
    // ==================
    async cleanup() {
        if (this.isTransmitting) await this.stopTransmit();
        this.stopCapture();
        if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
        if (this.speakerRef) { this.speakerRef.off(); this.speakerRef = null; }
        if (this.audioStreamRef) { this.audioStreamRef.off(); this.audioStreamRef = null; }
        if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
        this.playQueue = [];
        this.isPlaying = false;
    }
};
