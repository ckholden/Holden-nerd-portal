// ========================================
// CHAT MODULE
// ========================================

const Chat = {
    chatRef: null,
    messageLimit: 100,
    cleanupInterval: null,
    _notifyCtx: null,
    _initialLoad: true,

    // Messages older than 24 hours are auto-deleted
    RETENTION_MS: 24 * 60 * 60 * 1000,

    // Initialize chat
    init() {
        console.log('[Chat] Initializing...');

        // Setup chat form
        document.getElementById('chat-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.sendMessage();
        });

        // Allow Enter to send (but Shift+Enter for newline in future)
        document.getElementById('chat-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Request notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    },

    // Start listening to chat for a channel
    startListening(channel) {
        console.log('[Chat] Listening to channel:', channel);

        // Clear existing display
        this.clearMessages();
        this._initialLoad = true;

        // Setup listener
        this.chatRef = database.ref(`channels/${channel}/chat`);

        // Only load messages from the last 24 hours
        const cutoff = Date.now() - this.RETENTION_MS;

        const query = this.chatRef
            .orderByChild('timestamp')
            .startAt(cutoff)
            .limitToLast(this.messageLimit);

        query.on('child_added', (snapshot) => {
            const message = snapshot.val();
            this.displayMessage(message);
        });

        // After initial data loads, enable notifications
        query.once('value', () => {
            this._initialLoad = false;
        });

        // Cleanup old messages periodically (every 10 minutes)
        this.startCleanup(channel);
    },

    // Stop listening to current channel
    stopListening() {
        if (this.chatRef) {
            this.chatRef.off();
            this.chatRef = null;
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    },

    // Switch channels
    switchChannel(oldChannel, newChannel) {
        this.stopListening();
        this.startListening(newChannel);
    },

    // Periodically clean up old messages from the database
    startCleanup(channel) {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        // Run cleanup every 10 minutes
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldMessages(channel);
        }, 10 * 60 * 1000);

        // Also run once now
        this.cleanupOldMessages(channel);
    },

    // Delete messages older than 24 hours
    async cleanupOldMessages(channel) {
        const cutoff = Date.now() - this.RETENTION_MS;
        const chatRef = database.ref(`channels/${channel}/chat`);

        try {
            const snapshot = await chatRef
                .orderByChild('timestamp')
                .endAt(cutoff)
                .once('value');

            snapshot.forEach((child) => {
                child.ref.remove();
            });
        } catch (error) {
            console.error('[Chat] Error cleaning up old messages:', error);
        }
    },

    // Send a message
    async sendMessage() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();

        if (!text) return;
        if (!Auth.getUser()) return;

        const channel = Channels.getCurrentChannel();
        const chatRef = database.ref(`channels/${channel}/chat`);

        try {
            await chatRef.push({
                user: Auth.getUser().displayName,
                userId: Auth.getUserId(),
                text: text,
                timestamp: firebase.database.ServerValue.TIMESTAMP
            });

            input.value = '';
            console.log('[Chat] Message sent');

        } catch (error) {
            console.error('[Chat] Error sending message:', error);
        }
    },

    // Display a message in the chat
    displayMessage(message) {
        const container = document.getElementById('chat-messages');

        const div = document.createElement('div');
        div.className = 'chat-message';

        // Highlight if it's the current user's message
        const isOwn = message.userId === Auth.getUserId();
        if (isOwn) {
            div.classList.add('own');
        }

        const time = message.timestamp ? new Date(message.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        }) : '';

        div.innerHTML = `
            <div class="sender">${this.escapeHtml(message.user)}</div>
            <div class="text">${this.escapeHtml(message.text)}</div>
            <div class="time">${time}</div>
        `;

        container.appendChild(div);

        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;

        // Notify if message is from someone else and tab is not focused
        if (!isOwn && !this._initialLoad && document.hidden) {
            this.playNotifyBeep();
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('Holden PTT', {
                    body: `${message.user}: ${message.text}`,
                    tag: 'chat-msg'
                });
            }
        }
    },

    // Short beep for incoming chat messages
    playNotifyBeep() {
        if (!this._notifyCtx) {
            this._notifyCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        const ctx = this._notifyCtx;
        if (ctx.state === 'suspended') ctx.resume();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
    },

    // Add a system message
    addSystemMessage(text) {
        const container = document.getElementById('chat-messages');

        const div = document.createElement('div');
        div.className = 'chat-message system';

        const time = new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        div.innerHTML = `
            <div class="sender">SYSTEM</div>
            <div class="text">${this.escapeHtml(text)}</div>
            <div class="time">${time}</div>
        `;

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    },

    // Clear all messages
    clearMessages() {
        document.getElementById('chat-messages').innerHTML = '';
    },

    // Escape HTML to prevent XSS
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
