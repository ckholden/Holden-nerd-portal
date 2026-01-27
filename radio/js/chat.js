// ========================================
// CHAT MODULE
// ========================================

const Chat = {
    chatRef: null,
    messageLimit: 100,
    cleanupInterval: null,
    _notifyCtx: null,
    _initialLoad: true,
    _lastSender: null,
    _lastSenderTime: 0,
    _unreadCount: 0,
    _chatFocused: true,

    // Messages older than 24 hours are auto-deleted
    RETENTION_MS: 24 * 60 * 60 * 1000,

    // Group messages from same sender within 2 minutes
    GROUP_WINDOW: 2 * 60 * 1000,

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

        // Track chat visibility for unread badge
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this._chatFocused = true;
                this._unreadCount = 0;
                this.updateUnreadBadge();
            } else {
                this._chatFocused = false;
            }
        });
    },

    // Start listening to chat for a channel
    startListening(channel) {
        console.log('[Chat] Listening to channel:', channel);

        // Clear existing display
        this.clearMessages();
        this._initialLoad = true;
        this._lastSender = null;
        this._lastSenderTime = 0;

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

        const isOwn = message.userId === Auth.getUserId();
        const time = message.timestamp ? new Date(message.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        }) : '';

        // Check if this message should be grouped with the previous
        const timeDiff = message.timestamp ? (message.timestamp - this._lastSenderTime) : Infinity;
        const isGrouped = (message.userId === this._lastSender) && (timeDiff < this.GROUP_WINDOW);

        const div = document.createElement('div');
        div.className = 'chat-message';
        if (isOwn) div.classList.add('own');
        if (isGrouped) div.classList.add('grouped');

        if (isGrouped) {
            // No sender name, just text + time
            const textDiv = document.createElement('div');
            textDiv.className = 'text';
            textDiv.innerHTML = this.linkify(this.escapeHtml(message.text));

            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            timeSpan.textContent = time;

            div.appendChild(textDiv);
            div.appendChild(timeSpan);
        } else {
            // Full message with sender and inline time
            const headerDiv = document.createElement('div');
            headerDiv.className = 'msg-header';

            const senderSpan = document.createElement('span');
            senderSpan.className = 'sender';
            senderSpan.textContent = message.user;

            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            timeSpan.textContent = time;

            headerDiv.appendChild(senderSpan);
            headerDiv.appendChild(timeSpan);

            const textDiv = document.createElement('div');
            textDiv.className = 'text';
            textDiv.innerHTML = this.linkify(this.escapeHtml(message.text));

            div.appendChild(headerDiv);
            div.appendChild(textDiv);
        }

        this._lastSender = message.userId;
        this._lastSenderTime = message.timestamp || 0;

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;

        // Unread badge + notification if tab not focused
        if (!isOwn && !this._initialLoad) {
            if (document.hidden) {
                this._unreadCount++;
                this.updateUnreadBadge();
                this.playNotifyBeep();
                if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification('Holden PTT', {
                        body: `${message.user}: ${message.text}`,
                        tag: 'chat-msg'
                    });
                }
            }
        }
    },

    // Convert URLs in text to clickable links
    linkify(escapedHtml) {
        return escapedHtml.replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1" target="_blank" rel="noopener">$1</a>'
        );
    },

    // Update unread badge
    updateUnreadBadge() {
        let badge = document.getElementById('chat-unread');
        if (this._unreadCount > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.id = 'chat-unread';
                badge.className = 'unread-badge';
                const chatHeader = document.querySelector('.chat-panel h2');
                chatHeader.appendChild(badge);
            }
            badge.textContent = this._unreadCount > 99 ? '99+' : this._unreadCount;
        } else {
            if (badge) badge.remove();
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

        // Reset grouping for system messages
        this._lastSender = null;

        const div = document.createElement('div');
        div.className = 'chat-message system';

        const time = new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        div.innerHTML = `
            <div class="msg-header"><span class="sender">SYSTEM</span><span class="time">${time}</span></div>
            <div class="text">${this.escapeHtml(text)}</div>
        `;

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    },

    // Clear all messages
    clearMessages() {
        document.getElementById('chat-messages').innerHTML = '';
        this._lastSender = null;
        this._lastSenderTime = 0;
    },

    // Escape HTML to prevent XSS
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
