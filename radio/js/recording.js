// ========================================
// RECORDING MODULE
// ========================================

const Recording = {
    mediaRecorder: null,
    audioChunks: [],
    isRecording: false,
    recordingStartTime: null,
    recordingsRef: null,

    // Maximum storage (500MB)
    MAX_STORAGE_BYTES: 500 * 1024 * 1024,

    // Auto-delete after 7 days (in milliseconds)
    RETENTION_PERIOD: 7 * 24 * 60 * 60 * 1000,

    // Initialize recording module
    init() {
        console.log('[Recording] Initializing...');

        // Setup record button
        document.getElementById('record-btn').addEventListener('click', () => {
            this.toggleRecording();
        });

        // Setup recordings modal
        document.getElementById('recordings-btn').addEventListener('click', () => {
            this.showRecordingsModal();
        });

        document.getElementById('close-recordings').addEventListener('click', () => {
            this.hideRecordingsModal();
        });

        // Close modal on backdrop click
        document.getElementById('recordings-modal').addEventListener('click', (e) => {
            if (e.target.id === 'recordings-modal') {
                this.hideRecordingsModal();
            }
        });
    },

    // Start listening for recordings
    startListening() {
        this.recordingsRef = database.ref('recordings');
    },

    // Toggle recording state
    async toggleRecording() {
        if (this.isRecording) {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    },

    // Start recording
    async startRecording() {
        if (this.isRecording) return;

        console.log('[Recording] Starting recording...');

        try {
            // Get audio stream (from PTT or new one)
            let stream;
            if (PTTAudio.localStream) {
                stream = PTTAudio.localStream;
            } else {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            // Record the microphone stream directly
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: this.getSupportedMimeType()
            });

            this.audioChunks = [];
            this.recordingStartTime = Date.now();

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = () => {
                this.saveRecording();
            };

            this.mediaRecorder.start(1000); // Collect data every second
            this.isRecording = true;

            // Update UI
            this.updateRecordingUI(true);

            console.log('[Recording] Recording started');

        } catch (error) {
            console.error('[Recording] Error starting recording:', error);
            Chat.addSystemMessage('Failed to start recording');
        }
    },

    // Stop recording
    async stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;

        console.log('[Recording] Stopping recording...');

        this.mediaRecorder.stop();
        this.isRecording = false;

        // Update UI
        this.updateRecordingUI(false);
    },

    // Get supported MIME type for recording
    getSupportedMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4'
        ];

        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return 'audio/webm';
    },

    // Save recording to Firebase Storage
    async saveRecording() {
        if (this.audioChunks.length === 0) {
            console.log('[Recording] No audio data to save');
            return;
        }

        console.log('[Recording] Saving recording...');

        const blob = new Blob(this.audioChunks, { type: this.getSupportedMimeType() });
        const duration = Math.round((Date.now() - this.recordingStartTime) / 1000);
        const channel = Channels.getCurrentChannel();
        const timestamp = Date.now();

        try {
            // Check storage quota first
            await this.enforceStorageQuota(blob.size);

            // Upload to Firebase Storage
            const filename = `recordings/${channel}_${timestamp}.webm`;
            const storageRef = storage.ref(filename);

            const snapshot = await storageRef.put(blob);
            const downloadUrl = await snapshot.ref.getDownloadURL();

            // Save metadata to database
            await database.ref('recordings').push({
                channel: channel,
                channelName: Channels.getChannelName(channel),
                timestamp: timestamp,
                duration: duration,
                size: blob.size,
                storageUrl: downloadUrl,
                storagePath: filename,
                recordedBy: Auth.getUser() ? Auth.getUser().displayName : 'Unknown'
            });

            console.log('[Recording] Recording saved successfully');
            Chat.addSystemMessage(`Recording saved (${duration}s)`);

        } catch (error) {
            console.error('[Recording] Error saving recording:', error);
            Chat.addSystemMessage('Failed to save recording');
        }
    },

    // Enforce storage quota
    async enforceStorageQuota(newFileSize) {
        const snapshot = await database.ref('recordings')
            .orderByChild('timestamp')
            .once('value');

        let totalSize = 0;
        const recordings = [];
        const now = Date.now();

        snapshot.forEach((child) => {
            const rec = child.val();
            rec.key = child.key;
            recordings.push(rec);
            totalSize += rec.size || 0;
        });

        // Delete old recordings (older than retention period)
        for (const rec of recordings) {
            if (now - rec.timestamp > this.RETENTION_PERIOD) {
                await this.deleteRecording(rec.key, rec.storagePath);
                totalSize -= rec.size || 0;
            }
        }

        // Delete oldest recordings if over quota
        recordings.sort((a, b) => a.timestamp - b.timestamp);

        while (totalSize + newFileSize > this.MAX_STORAGE_BYTES && recordings.length > 0) {
            const oldest = recordings.shift();
            await this.deleteRecording(oldest.key, oldest.storagePath);
            totalSize -= oldest.size || 0;
        }
    },

    // Delete a recording
    async deleteRecording(key, storagePath) {
        try {
            // Delete from storage
            if (storagePath) {
                await storage.ref(storagePath).delete();
            }

            // Delete from database
            await database.ref(`recordings/${key}`).remove();

            console.log('[Recording] Deleted recording:', key);
        } catch (error) {
            console.error('[Recording] Error deleting recording:', error);
        }
    },

    // Show recordings modal
    async showRecordingsModal() {
        const modal = document.getElementById('recordings-modal');
        const list = document.getElementById('recordings-list');

        modal.classList.remove('hidden');
        list.innerHTML = '<p class="loading">Loading recordings...</p>';

        try {
            const snapshot = await database.ref('recordings')
                .orderByChild('timestamp')
                .limitToLast(50)
                .once('value');

            const recordings = [];
            snapshot.forEach((child) => {
                recordings.push({ ...child.val(), key: child.key });
            });

            // Reverse to show newest first
            recordings.reverse();

            if (recordings.length === 0) {
                list.innerHTML = '<p class="no-recordings">No recordings yet</p>';
                return;
            }

            list.innerHTML = '';
            recordings.forEach((rec) => {
                const item = this.createRecordingItem(rec);
                list.appendChild(item);
            });

        } catch (error) {
            console.error('[Recording] Error loading recordings:', error);
            list.innerHTML = '<p class="no-recordings">Error loading recordings</p>';
        }
    },

    // Create recording list item
    createRecordingItem(rec) {
        const div = document.createElement('div');
        div.className = 'recording-item';

        const date = new Date(rec.timestamp);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        // Build DOM safely to prevent XSS
        const infoDiv = document.createElement('div');
        infoDiv.className = 'recording-info';

        const channelDiv = document.createElement('div');
        channelDiv.className = 'channel';
        channelDiv.textContent = rec.channelName;

        const dateDiv = document.createElement('div');
        dateDiv.className = 'date';
        dateDiv.textContent = dateStr;

        const durationDiv = document.createElement('div');
        durationDiv.className = 'duration';
        durationDiv.textContent = `${rec.duration}s • ${rec.recordedBy}`;

        infoDiv.appendChild(channelDiv);
        infoDiv.appendChild(dateDiv);
        infoDiv.appendChild(durationDiv);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'recording-actions';
        actionsDiv.innerHTML = `
            <button class="btn btn-play">▶ Play</button>
            <button class="btn btn-download">⬇ Download</button>
            <button class="btn btn-delete">🗑</button>
        `;

        div.appendChild(infoDiv);
        div.appendChild(actionsDiv);

        // Setup button handlers using closure (no data attributes needed)
        div.querySelector('.btn-play').addEventListener('click', () => {
            this.playRecording(rec.storageUrl);
        });

        div.querySelector('.btn-download').addEventListener('click', () => {
            this.downloadRecording(rec.storageUrl, `${rec.channelName}_${rec.timestamp}.webm`);
        });

        div.querySelector('.btn-delete').addEventListener('click', async () => {
            if (confirm('Delete this recording?')) {
                await this.deleteRecording(rec.key, rec.storagePath);
                div.remove();
            }
        });

        return div;
    },

    // Play a recording
    playRecording(url) {
        // Remove existing playback audio
        const existing = document.getElementById('playback-audio');
        if (existing) {
            existing.pause();
            existing.remove();
        }

        const audio = document.createElement('audio');
        audio.id = 'playback-audio';
        audio.src = url;
        audio.controls = true;
        audio.autoplay = true;
        document.body.appendChild(audio);

        // Auto-remove when done
        audio.onended = () => audio.remove();
    },

    // Download a recording
    downloadRecording(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        a.remove();
    },

    // Hide recordings modal
    hideRecordingsModal() {
        document.getElementById('recordings-modal').classList.add('hidden');

        // Stop any playback
        const audio = document.getElementById('playback-audio');
        if (audio) {
            audio.pause();
            audio.remove();
        }
    },

    // Update recording UI
    updateRecordingUI(recording) {
        const btn = document.getElementById('record-btn');
        const text = btn.querySelector('.record-text');

        if (recording) {
            btn.classList.add('recording');
            text.textContent = 'STOP';
        } else {
            btn.classList.remove('recording');
            text.textContent = 'RECORD';
        }
    },

    // Called when transmission starts
    onTransmitStart() {
        // Could auto-start recording here if desired
    },

    // Called when transmission stops
    onTransmitStop() {
        // Could implement voice-activated recording here
    }
};
