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
    _typingRef: null,
    _typingTimeout: null,
    _typingListenerRef: null,

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
        const chatInput = document.getElementById('chat-input');
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Typing indicator - broadcast when typing
        chatInput.addEventListener('input', () => {
            this.broadcastTyping();
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

        // Start typing indicator
        this.startTypingListener(channel);
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
        this.stopTypingListener();
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

    // Send a message (or handle a /command)
    async sendMessage() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();

        if (!text) return;
        if (!Auth.getUser()) return;

        // Check for /commands
        if (text.startsWith('/')) {
            input.value = '';
            if (this._typingRef) this._typingRef.remove();
            if (this._typingTimeout) { clearTimeout(this._typingTimeout); this._typingTimeout = null; }
            this.handleCommand(text);
            return;
        }

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
            if (this._typingRef) this._typingRef.remove();
            if (this._typingTimeout) { clearTimeout(this._typingTimeout); this._typingTimeout = null; }
            console.log('[Chat] Message sent');

        } catch (error) {
            console.error('[Chat] Error sending message:', error);
        }
    },

    // Handle /commands
    async handleCommand(text) {
        const parts = text.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');

        switch (cmd) {
            case '/help':
                this.addSystemMessage('Available commands:');
                this.addSystemMessage('/help — Show this list');
                this.addSystemMessage('/adminhelp — Open admin tools panel (admin)');
                this.addSystemMessage('/clearchat — Clear chat history (admin)');
                this.addSystemMessage('/kick <name> — Kick a user (admin)');
                this.addSystemMessage('/lock — Toggle channel lock (admin)');
                break;

            case '/clearchat':
                if (!Auth.getIsAdmin()) {
                    this.addSystemMessage('Admin only.');
                    return;
                }
                await this.clearChatHistory();
                break;

            case '/kick':
                if (!Auth.getIsAdmin()) {
                    this.addSystemMessage('Admin only.');
                    return;
                }
                if (!args) {
                    this.addSystemMessage('Usage: /kick <name>');
                    return;
                }
                await this.kickByName(args);
                break;

            case '/lock':
                if (!Auth.getIsAdmin()) {
                    this.addSystemMessage('Admin only.');
                    return;
                }
                await Channels.toggleChannelLock();
                break;

            case '/adminhelp':
                if (!Auth.getIsAdmin()) {
                    this.addSystemMessage('Admin only.');
                    return;
                }
                this.showAdminHelpModal();
                break;

            default:
                this.addSystemMessage(`Unknown command: ${cmd}. Type /help for a list.`);
                break;
        }
    },

    // Clear all chat messages from Firebase for the current channel (admin)
    async clearChatHistory() {
        const channel = Channels.getCurrentChannel();
        try {
            await database.ref(`channels/${channel}/chat`).remove();
            this.clearMessages();
            this.addSystemMessage('Chat history cleared.');
            console.log('[Chat] Chat history cleared by admin');
        } catch (error) {
            console.error('[Chat] Error clearing chat:', error);
            this.addSystemMessage('Failed to clear chat.');
        }
    },

    // Kick a user by display name (admin)
    async kickByName(name) {
        const channel = Channels.getCurrentChannel();
        const target = name.toLowerCase();
        try {
            const snap = await database.ref('users')
                .orderByChild('currentChannel')
                .equalTo(channel)
                .once('value');

            let found = false;
            snap.forEach((child) => {
                const user = child.val();
                if (user.online && user.displayName && user.displayName.toLowerCase() === target) {
                    Channels.kickUser(child.key);
                    found = true;
                }
            });

            if (!found) {
                this.addSystemMessage(`No user named "${name}" in this channel.`);
            }
        } catch (error) {
            console.error('[Chat] Error kicking by name:', error);
            this.addSystemMessage('Failed to kick user.');
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

        // Unread badge + notification if chat not visible
        if (!isOwn && !this._initialLoad) {
            const chatNotVisible = document.hidden || (App._isMobile && App._activeTab !== 'chat');
            if (chatNotVisible) {
                this._unreadCount++;
                this.updateUnreadBadge();
                this.playNotifyBeep();
                if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification('Holden PTT', {
                        body: `${message.user}: ${message.text}`,
                        tag: 'chat-msg-' + Date.now()
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
        // Also update mobile tab badge
        if (typeof App !== 'undefined') {
            App.updateMobileUnreadBadge(this._unreadCount);
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

    // Broadcast typing status
    broadcastTyping() {
        if (!this._typingRef) return;
        const user = Auth.getUser();
        if (!user) return;

        this._typingRef.set({
            userId: Auth.getUserId(),
            displayName: user.displayName,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });

        // Clear typing after 3 seconds of inactivity
        if (this._typingTimeout) clearTimeout(this._typingTimeout);
        this._typingTimeout = setTimeout(() => {
            if (this._typingRef) this._typingRef.remove();
        }, 3000);
    },

    // Start listening for typing from others
    startTypingListener(channel) {
        this._typingRef = database.ref(`channels/${channel}/typing/${Auth.getUserId()}`);
        this._typingRef.onDisconnect().remove();

        this._typingListenerRef = database.ref(`channels/${channel}/typing`);
        this._typingListenerRef.on('value', (snap) => {
            const data = snap.val();
            const indicator = document.getElementById('typing-indicator');
            const userSpan = document.getElementById('typing-user');
            if (!data) {
                indicator.classList.add('hidden');
                return;
            }

            const typers = Object.values(data)
                .filter(t => t.userId !== Auth.getUserId())
                .filter(t => t.timestamp && (Date.now() - t.timestamp) < 5000);

            if (typers.length > 0) {
                indicator.classList.remove('hidden');
                if (typers.length === 1) {
                    userSpan.textContent = typers[0].displayName + ' is typing';
                } else {
                    userSpan.textContent = typers.length + ' people typing';
                }
            } else {
                indicator.classList.add('hidden');
            }
        });
    },

    stopTypingListener() {
        if (this._typingTimeout) { clearTimeout(this._typingTimeout); this._typingTimeout = null; }
        if (this._typingRef) { this._typingRef.remove(); this._typingRef = null; }
        if (this._typingListenerRef) { this._typingListenerRef.off(); this._typingListenerRef = null; }
    },

    // Clear all messages
    clearMessages() {
        document.getElementById('chat-messages').innerHTML = '';
        this._lastSender = null;
        this._lastSenderTime = 0;
    },

    // Show admin help modal with tools
    async showAdminHelpModal() {
        // Remove existing modal if any
        const existing = document.getElementById('admin-help-modal');
        if (existing) existing.remove();

        // Get online users in current channel
        const channel = Channels.getCurrentChannel();
        let users = [];
        try {
            const snap = await database.ref('users')
                .orderByChild('currentChannel')
                .equalTo(channel)
                .once('value');
            snap.forEach((child) => {
                const u = child.val();
                if (Channels.isUserOnline(u) && child.key !== Auth.getUserId()) {
                    users.push({ uid: child.key, name: u.displayName });
                }
            });
        } catch (e) {
            console.error('[Chat] Error loading users for admin panel:', e);
        }

        const userRows = users.length > 0
            ? users.map(u =>
                `<div class="admin-user-row" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-input);border-radius:var(--radius-sm);margin-bottom:4px;">
                    <span style="font-size:14px;">${this.escapeHtml(u.name)}</span>
                    <button class="btn-kick admin-kick-btn" data-uid="${u.uid}" data-name="${this.escapeHtml(u.name)}" style="padding:4px 10px;font-size:10px;">KICK</button>
                </div>`
            ).join('')
            : '<p style="color:var(--text-dim);font-size:13px;">No other users in channel</p>';

        const modal = document.createElement('div');
        modal.id = 'admin-help-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:450px;">
                <div class="modal-header">
                    <h2>ADMIN TOOLS</h2>
                    <button id="close-admin-help" class="btn btn-close">&#10005;</button>
                </div>
                <div style="padding:20px;overflow-y:auto;">
                    <div style="margin-bottom:20px;">
                        <h3 style="font-family:var(--font-mono);font-size:11px;letter-spacing:2px;color:var(--accent-green);margin-bottom:10px;">COMMANDS</h3>
                        <div style="background:var(--bg-input);border-radius:var(--radius-md);padding:12px;font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);line-height:2;">
                            <div><span style="color:var(--accent-green);">/kick &lt;name&gt;</span> — Remove a user</div>
                            <div><span style="color:var(--accent-green);">/lock</span> — Lock/unlock channel</div>
                            <div><span style="color:var(--accent-green);">/clearchat</span> — Wipe chat history</div>
                            <div><span style="color:var(--accent-green);">/adminhelp</span> — This panel</div>
                        </div>
                    </div>
                    <div style="margin-bottom:20px;">
                        <h3 style="font-family:var(--font-mono);font-size:11px;letter-spacing:2px;color:var(--accent-green);margin-bottom:10px;">QUICK ACTIONS</h3>
                        <button id="admin-toggle-lock" class="btn btn-admin" style="width:100%;margin-bottom:8px;">TOGGLE CHANNEL LOCK</button>
                        <button id="admin-clear-chat" class="btn btn-admin" style="width:100%;">CLEAR CHAT HISTORY</button>
                    </div>
                    <div>
                        <h3 style="font-family:var(--font-mono);font-size:11px;letter-spacing:2px;color:var(--accent-red);margin-bottom:10px;">USERS IN CHANNEL</h3>
                        <div id="admin-user-list">${userRows}</div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Close button
        document.getElementById('close-admin-help').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        // Toggle lock button
        document.getElementById('admin-toggle-lock').addEventListener('click', async () => {
            await Channels.toggleChannelLock();
            modal.remove();
        });

        // Clear chat button
        document.getElementById('admin-clear-chat').addEventListener('click', async () => {
            if (confirm('Clear all chat messages?')) {
                await this.clearChatHistory();
                modal.remove();
            }
        });

        // Kick buttons
        modal.querySelectorAll('.admin-kick-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uid = btn.dataset.uid;
                const name = btn.dataset.name;
                if (confirm(`Kick ${name}?`)) {
                    await Channels.kickUser(uid);
                    btn.closest('.admin-user-row').remove();
                    this.addSystemMessage(`${name} has been kicked.`);
                }
            });
        });
    },

    // Escape HTML to prevent XSS
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
