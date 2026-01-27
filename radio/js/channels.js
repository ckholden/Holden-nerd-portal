// ========================================
// CHANNELS MODULE
// ========================================

const Channels = {
    currentChannel: 'main',
    channelList: ['main', 'channel2', 'channel3', 'channel4'],
    userRef: null,
    presenceRef: null,
    channelListeners: {},
    _heartbeatInterval: null,
    _heartbeatVisHandler: null,
    HEARTBEAT_INTERVAL_MS: 30000,
    HEARTBEAT_STALE_MS: 120000,

    // Initialize channels
    init() {
        console.log('[Channels] Initializing...');

        // Setup channel button clicks
        document.querySelectorAll('.channel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const channel = btn.dataset.channel;
                this.switchChannel(channel);
            });
        });
    },

    // Join initial channel after login
    async joinInitialChannel(user) {
        console.log('[Channels] Joining initial channel...');

        this.userRef = database.ref(`users/${user.uid}`);

        // Set user data
        await this.userRef.set({
            displayName: user.displayName,
            online: true,
            currentChannel: this.currentChannel,
            lastSeen: firebase.database.ServerValue.TIMESTAMP,
            heartbeat: firebase.database.ServerValue.TIMESTAMP,
            kicked: false
        });

        // Listen for being kicked
        this.userRef.child('kicked').on('value', (snap) => {
            if (snap.val() === true) {
                alert('You have been kicked by an admin.');
                Auth.logout();
            }
        });

        // Admin: setup lock channel button
        if (Auth.getIsAdmin()) {
            document.getElementById('lock-channel-btn').addEventListener('click', () => {
                this.toggleChannelLock();
            });
            // Check initial lock state
            const lockSnap = await database.ref(`channels/${this.currentChannel}/locked`).once('value');
            this.updateLockUI(lockSnap.val() === true);
        }

        // Setup presence (detect disconnect)
        this.setupPresence(user);

        // Start heartbeat
        this.startHeartbeat();

        // Listen to all channels for user counts
        this.channelList.forEach(channel => {
            this.listenToChannel(channel);
        });

        // Update member list for current channel
        this.updateMemberList();
    },

    // Setup presence detection
    setupPresence(user) {
        const connectedRef = database.ref('.info/connected');

        connectedRef.on('value', (snapshot) => {
            if (snapshot.val() === true) {
                console.log('[Channels] Connected to Firebase');

                // Set online status
                this.userRef.update({ online: true });

                // Setup disconnect cleanup
                this.userRef.onDisconnect().update({
                    online: false,
                    lastSeen: firebase.database.ServerValue.TIMESTAMP
                });

                // Update connection status UI
                document.querySelector('.status-led').classList.add('online');
                document.querySelector('.status-led').classList.remove('offline');
                document.getElementById('connection-text').textContent = 'CONNECTED';
            } else {
                console.log('[Channels] Disconnected from Firebase');
                document.querySelector('.status-led').classList.remove('online');
                document.querySelector('.status-led').classList.add('offline');
                document.getElementById('connection-text').textContent = 'DISCONNECTED';
            }
        });
    },

    // Listen to a channel for user counts
    listenToChannel(channel) {
        const usersRef = database.ref('users');

        // Query users in this channel
        const query = usersRef.orderByChild('currentChannel').equalTo(channel);

        this.channelListeners[channel] = query.on('value', (snapshot) => {
            let count = 0;
            snapshot.forEach((child) => {
                if (this.isUserOnline(child.val())) {
                    count++;
                }
            });

            // Update channel user count badge
            const badge = document.querySelector(`.channel-users[data-channel="${channel}"]`);
            if (badge) {
                badge.textContent = count;
            }

            // Update member list if this is current channel
            if (channel === this.currentChannel) {
                this.updateMemberListFromSnapshot(snapshot);
            }
        });
    },

    // Switch to a different channel
    async switchChannel(newChannel) {
        if (newChannel === this.currentChannel) return;

        console.log('[Channels] Switching to:', newChannel);

        const oldChannel = this.currentChannel;
        this.currentChannel = newChannel;

        // Update user's channel in database
        if (this.userRef) {
            await this.userRef.update({
                currentChannel: newChannel
            });
        }

        // Update UI - channel buttons
        document.querySelectorAll('.channel-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.channel === newChannel) {
                btn.classList.add('active');
            }
        });

        // Notify other modules
        if (typeof Chat !== 'undefined') {
            Chat.switchChannel(oldChannel, newChannel);
        }

        if (typeof PTTAudio !== 'undefined') {
            PTTAudio.switchChannel(oldChannel, newChannel);
        }

        if (typeof Alerts !== 'undefined') {
            Alerts.switchChannel(newChannel);
        }

        // Update member list
        this.updateMemberList();

        // Add system message
        if (typeof Chat !== 'undefined') {
            Chat.addSystemMessage(`Switched to ${this.getChannelName(newChannel)}`);
        }
    },

    // Get display name for channel
    getChannelName(channel) {
        const names = {
            'main': 'Main Channel',
            'channel2': 'Channel 2',
            'channel3': 'Channel 3',
            'channel4': 'Channel 4'
        };
        return names[channel] || channel;
    },

    // Update member list display
    updateMemberList() {
        const usersRef = database.ref('users');
        const query = usersRef.orderByChild('currentChannel').equalTo(this.currentChannel);

        query.once('value', (snapshot) => {
            this.updateMemberListFromSnapshot(snapshot);
        });
    },

    // Update member list from snapshot
    updateMemberListFromSnapshot(snapshot) {
        const memberList = document.getElementById('member-list');
        memberList.innerHTML = '';

        snapshot.forEach((child) => {
            const user = child.val();
            if (this.isUserOnline(user)) {
                const li = document.createElement('li');
                li.dataset.uid = child.key;

                const nameSpan = document.createElement('span');
                nameSpan.className = 'member-name';
                nameSpan.textContent = user.displayName;
                li.appendChild(nameSpan);

                // Admin kick button (don't show for self)
                if (Auth.getIsAdmin() && child.key !== Auth.getUserId()) {
                    const kickBtn = document.createElement('button');
                    kickBtn.className = 'btn-kick';
                    kickBtn.textContent = 'KICK';
                    kickBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (confirm(`Kick ${user.displayName}?`)) {
                            this.kickUser(child.key);
                        }
                    });
                    li.appendChild(kickBtn);
                }

                memberList.appendChild(li);
            }
        });
    },

    // Kick a user (admin only)
    async kickUser(userId) {
        if (!Auth.getIsAdmin()) return;
        try {
            await database.ref(`users/${userId}`).update({
                kicked: true,
                online: false,
                currentChannel: null
            });
            console.log('[Channels] Kicked user:', userId);
            Chat.addSystemMessage('User has been kicked.');
        } catch (err) {
            console.error('[Channels] Kick error:', err);
        }
    },

    // Lock/unlock current channel (admin only)
    async toggleChannelLock() {
        if (!Auth.getIsAdmin()) return;
        const channel = this.currentChannel;
        const lockRef = database.ref(`channels/${channel}/locked`);
        const snap = await lockRef.once('value');
        const isLocked = snap.val();
        await lockRef.set(!isLocked);
        Chat.addSystemMessage(isLocked ? 'Channel UNLOCKED' : 'Channel LOCKED');
        this.updateLockUI(!isLocked);
    },

    // Update lock button UI
    updateLockUI(locked) {
        const btn = document.getElementById('lock-channel-btn');
        if (btn) {
            btn.textContent = locked ? 'UNLOCK CHANNEL' : 'LOCK CHANNEL';
            btn.classList.toggle('locked', locked);
        }
    },

    // Check if channel is locked (for non-admins)
    async isChannelLocked(channel) {
        const snap = await database.ref(`channels/${channel}/locked`).once('value');
        return snap.val() === true;
    },

    // Mark user as speaking
    markSpeaking(userId, isSpeaking) {
        const memberItems = document.querySelectorAll('#member-list li');
        memberItems.forEach(li => {
            if (li.dataset.uid === userId) {
                if (isSpeaking) {
                    li.classList.add('speaking');
                } else {
                    li.classList.remove('speaking');
                }
            }
        });
    },

    // Check if a user is online using heartbeat (falls back to online flag)
    isUserOnline(user) {
        if (user.heartbeat) {
            return (Date.now() - user.heartbeat) < this.HEARTBEAT_STALE_MS;
        }
        return user.online;
    },

    // Write heartbeat timestamp to Firebase
    writeHeartbeat() {
        if (this.userRef) {
            this.userRef.child('heartbeat').set(firebase.database.ServerValue.TIMESTAMP);
        }
    },

    // Start periodic heartbeat
    startHeartbeat() {
        this.stopHeartbeat();
        this.writeHeartbeat();
        this._heartbeatInterval = setInterval(() => this.writeHeartbeat(), this.HEARTBEAT_INTERVAL_MS);

        // Re-establish heartbeat when tab becomes visible again
        this._heartbeatVisHandler = () => {
            if (!document.hidden) {
                this.writeHeartbeat();
            }
        };
        document.addEventListener('visibilitychange', this._heartbeatVisHandler);
    },

    // Stop heartbeat
    stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
        if (this._heartbeatVisHandler) {
            document.removeEventListener('visibilitychange', this._heartbeatVisHandler);
            this._heartbeatVisHandler = null;
        }
    },

    // Get current channel
    getCurrentChannel() {
        return this.currentChannel;
    },

    // Cleanup on logout
    async cleanup() {
        console.log('[Channels] Cleaning up...');

        this.stopHeartbeat();

        // Remove listeners
        Object.keys(this.channelListeners).forEach(channel => {
            const usersRef = database.ref('users');
            usersRef.orderByChild('currentChannel').equalTo(channel).off();
        });

        // Set offline
        if (this.userRef) {
            await this.userRef.update({
                online: false,
                lastSeen: firebase.database.ServerValue.TIMESTAMP
            });
        }

        this.currentChannel = 'main';
        this.userRef = null;
    }
};
