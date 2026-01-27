// ========================================
// ALERTS MODULE
// ========================================

const Alerts = {
    alertRef: null,
    alertSound: null,
    isAlertPlaying: false,
    alertTimeout: null,

    // Initialize alerts
    init() {
        console.log('[Alerts] Initializing...');

        // Create alert sound (two-tone EMS style)
        this.createAlertSound();

        // Setup alert button
        document.getElementById('alert-btn').addEventListener('click', () => {
            this.sendAlert();
        });
    },

    // Create the alert sound using Web Audio API
    createAlertSound() {
        // We'll create a two-tone alert programmatically
        this.audioContext = null;
    },

    // Generate two-tone alert sound
    playTwoToneAlert() {
        // Create audio context on demand (browsers require user interaction)
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const ctx = this.audioContext;
        const now = ctx.currentTime;

        // EMS-style two-tone: alternating frequencies
        const frequencies = [853.2, 960]; // Standard two-tone frequencies
        const duration = 0.5; // Each tone duration
        const cycles = 3; // Number of cycles

        for (let i = 0; i < cycles * 2; i++) {
            const oscillator = ctx.createOscillator();
            const gainNode = ctx.createGain();

            oscillator.type = 'sine';
            oscillator.frequency.value = frequencies[i % 2];
            oscillator.connect(gainNode);
            gainNode.connect(ctx.destination);

            const startTime = now + (i * duration);
            const endTime = startTime + duration;

            gainNode.gain.setValueAtTime(0.3, startTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, endTime);

            oscillator.start(startTime);
            oscillator.stop(endTime);
        }
    },

    // Start listening for alerts on a channel
    startListening(channel) {
        console.log('[Alerts] Listening for alerts on:', channel);

        this.alertRef = database.ref(`channels/${channel}/activeAlert`);

        this.alertRef.on('value', (snapshot) => {
            const alert = snapshot.val();
            if (alert && alert.active) {
                this.showAlert(alert);
            } else {
                this.hideAlert();
            }
        });
    },

    // Stop listening
    stopListening() {
        if (this.alertRef) {
            this.alertRef.off();
            this.alertRef = null;
        }
    },

    // Switch channels
    switchChannel(newChannel) {
        this.stopListening();
        this.startListening(newChannel);
    },

    // Send an alert to the current channel
    async sendAlert() {
        const channel = Channels.getCurrentChannel();
        const user = Auth.getUser();

        if (!user) return;

        console.log('[Alerts] Sending alert on:', channel);

        try {
            await database.ref(`channels/${channel}/activeAlert`).set({
                active: true,
                sender: user.displayName,
                senderId: Auth.getUserId(),
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });

            // Auto-clear after 3 seconds
            setTimeout(async () => {
                const currentAlert = await database.ref(`channels/${channel}/activeAlert`).once('value');
                const alertData = currentAlert.val();
                if (alertData && alertData.senderId === Auth.getUserId()) {
                    await database.ref(`channels/${channel}/activeAlert`).remove();
                }
            }, 3000);

        } catch (error) {
            console.error('[Alerts] Error sending alert:', error);
        }
    },

    // Show alert overlay and play sound
    showAlert(alert) {
        if (this.isAlertPlaying) return;

        console.log('[Alerts] Showing alert from:', alert.sender);
        this.isAlertPlaying = true;

        // Update overlay
        const overlay = document.getElementById('alert-overlay');
        const senderEl = document.getElementById('alert-sender');

        senderEl.textContent = `From: ${alert.sender}`;
        overlay.classList.remove('hidden');

        // Play sound
        this.playTwoToneAlert();

        // Add system message
        if (typeof Chat !== 'undefined') {
            Chat.addSystemMessage(`ALERT from ${alert.sender}`);
        }

        // Auto-hide after 5 seconds as a safety net
        this.alertTimeout = setTimeout(() => {
            this.hideAlert();
        }, 5000);
    },

    // Hide alert overlay
    hideAlert() {
        if (!this.isAlertPlaying) return;

        console.log('[Alerts] Hiding alert');
        this.isAlertPlaying = false;

        const overlay = document.getElementById('alert-overlay');
        overlay.classList.add('hidden');

        if (this.alertTimeout) {
            clearTimeout(this.alertTimeout);
            this.alertTimeout = null;
        }
    }
};
