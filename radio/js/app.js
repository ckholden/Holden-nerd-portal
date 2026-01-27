// ========================================
// MAIN APPLICATION
// ========================================

const App = {
    initialized: false,
    _activeTab: 'radio',
    _isMobile: false,
    _wakeLock: null,
    _wakeLockIdleTimer: null,
    WAKE_LOCK_IDLE_MS: 30000,

    // Initialize the application
    init() {
        console.log('[App] Initializing Holden PTT...');

        // Check if Firebase is configured
        if (!isFirebaseConfigured()) {
            this.showConfigError();
            return;
        }

        // Initialize Firebase
        if (!initializeFirebase()) {
            this.showConfigError();
            return;
        }

        // Initialize all modules
        Auth.init();
        Channels.init();
        Chat.init();
        PTTAudio.init();
        Alerts.init();
        Recording.init();

        // Initialize mobile tab system
        this.initMobileTabs();

        this.initialized = true;
        console.log('[App] Initialization complete');

        // Attempt auto-reconnect from stored session
        Auth.tryAutoReconnect();
    },

    // ========================================
    // MOBILE TAB SYSTEM
    // ========================================

    initMobileTabs() {
        this._checkMobile();
        window.addEventListener('resize', () => this._checkMobile());

        // Tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });

        // Compact PTT button — mirror the main PTT button behavior
        const compactBtn = document.getElementById('compact-ptt-btn');
        const mainBtn = document.getElementById('ptt-btn');
        if (compactBtn && mainBtn) {
            // Forward pointer events to main PTT button
            compactBtn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                mainBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            });
            compactBtn.addEventListener('pointerup', (e) => {
                e.preventDefault();
                mainBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            });
            compactBtn.addEventListener('pointerleave', (e) => {
                e.preventDefault();
                mainBtn.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
            });
        }

        // Sync compact toggle mode with main toggle
        const compactToggle = document.getElementById('compact-ptt-toggle-mode');
        const mainToggle = document.getElementById('ptt-toggle-mode');
        if (compactToggle && mainToggle) {
            compactToggle.addEventListener('change', () => {
                mainToggle.checked = compactToggle.checked;
                mainToggle.dispatchEvent(new Event('change'));
            });
            mainToggle.addEventListener('change', () => {
                compactToggle.checked = mainToggle.checked;
            });
        }

        // Observe main PTT button class changes to sync compact button state
        if (mainBtn && compactBtn) {
            const observer = new MutationObserver(() => {
                const isActive = mainBtn.classList.contains('active');
                compactBtn.classList.toggle('active', isActive);
            });
            observer.observe(mainBtn, { attributes: true, attributeFilter: ['class'] });
        }

        // Observe TX indicator to sync compact status text
        const txIndicator = document.getElementById('tx-indicator');
        const compactTxText = document.getElementById('compact-tx-text');
        if (txIndicator && compactTxText) {
            const txObserver = new MutationObserver(() => {
                const txText = txIndicator.querySelector('.tx-text');
                if (txText) {
                    compactTxText.textContent = txText.textContent;
                }
                compactTxText.classList.toggle('transmitting', txIndicator.classList.contains('transmitting'));
                compactTxText.classList.toggle('receiving', txIndicator.classList.contains('receiving'));
            });
            txObserver.observe(txIndicator, { attributes: true, attributeFilter: ['class'], subtree: true, characterData: true, childList: true });
        }

        // Observe audio meter to sync compact meter
        const meterFill = document.getElementById('meter-fill');
        const compactMeter = document.getElementById('compact-meter');
        const compactMeterFill = document.getElementById('compact-meter-fill');
        const audioMeter = document.getElementById('audio-meter');
        if (meterFill && compactMeterFill && audioMeter) {
            const meterObserver = new MutationObserver(() => {
                const isVisible = !audioMeter.classList.contains('hidden');
                compactMeter.classList.toggle('active', isVisible);
            });
            meterObserver.observe(audioMeter, { attributes: true, attributeFilter: ['class'] });

            // Sync meter fill width via polling when active (style changes aren't caught by MutationObserver)
            setInterval(() => {
                if (compactMeter.classList.contains('active')) {
                    compactMeterFill.style.width = meterFill.style.width;
                }
            }, 50);
        }

        // Apply initial state
        if (this._isMobile) {
            this.switchTab('radio');
        }
    },

    _checkMobile() {
        this._isMobile = window.innerWidth <= 768;
        if (this._isMobile) {
            this.switchTab(this._activeTab);
        } else {
            // Desktop: make sure both views are visible
            const radioView = document.querySelector('.radio-view');
            const chatPanel = document.querySelector('.chat-panel');
            if (radioView) radioView.classList.remove('tab-hidden');
            if (chatPanel) chatPanel.classList.remove('tab-hidden');
        }
    },

    switchTab(tab) {
        this._activeTab = tab;
        const radioView = document.querySelector('.radio-view');
        const chatPanel = document.querySelector('.chat-panel');

        // Toggle views
        if (tab === 'radio') {
            if (radioView) radioView.classList.remove('tab-hidden');
            if (chatPanel) chatPanel.classList.add('tab-hidden');
        } else {
            if (radioView) radioView.classList.add('tab-hidden');
            if (chatPanel) chatPanel.classList.remove('tab-hidden');
            // Clear unread when switching to chat
            if (typeof Chat !== 'undefined' && Chat._unreadCount > 0) {
                Chat._unreadCount = 0;
                Chat.updateUnreadBadge();
            }
            this._updateTabBadge(0);
        }

        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
    },

    // Called from Chat module to update tab badge
    updateMobileUnreadBadge(count) {
        if (!this._isMobile) return;
        if (this._activeTab === 'chat') return; // Don't show badge if already on chat
        this._updateTabBadge(count);
    },

    _updateTabBadge(count) {
        const badge = document.getElementById('tab-chat-badge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    },

    // Request wake lock to keep screen on during audio activity
    async requestWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            this._wakeLock = await navigator.wakeLock.request('screen');
            this._wakeLock.addEventListener('release', () => {
                this._wakeLock = null;
            });
            console.log('[App] Wake lock acquired');
        } catch (e) {
            console.warn('[App] Wake lock request failed:', e);
        }
    },

    // Release wake lock
    releaseWakeLock() {
        if (this._wakeLock) {
            this._wakeLock.release().catch(() => {});
            this._wakeLock = null;
            console.log('[App] Wake lock released');
        }
    },

    // Called when audio activity starts (TX or RX)
    onAudioActivity() {
        if (this._wakeLockIdleTimer) {
            clearTimeout(this._wakeLockIdleTimer);
            this._wakeLockIdleTimer = null;
        }
        if (!this._wakeLock) {
            this.requestWakeLock();
        }
    },

    // Called when audio goes idle (standby)
    onAudioIdle() {
        if (this._wakeLockIdleTimer) clearTimeout(this._wakeLockIdleTimer);
        this._wakeLockIdleTimer = setTimeout(() => {
            this.releaseWakeLock();
            this._wakeLockIdleTimer = null;
        }, this.WAKE_LOCK_IDLE_MS);
    },

    // Monitor Firebase connection state
    monitorConnection() {
        const connRef = database.ref('.info/connected');
        const banner = document.getElementById('connection-banner');
        const bannerText = document.getElementById('connection-banner-text');
        const statusLed = document.querySelector('.status-led');
        const connText = document.getElementById('connection-text');
        let wasDisconnected = false;

        connRef.on('value', (snap) => {
            if (snap.val() === true) {
                if (wasDisconnected) {
                    banner.classList.remove('hidden');
                    banner.classList.add('restored');
                    bannerText.textContent = 'CONNECTION RESTORED';
                    setTimeout(() => banner.classList.add('hidden'), 3000);
                }
                statusLed.className = 'status-led online';
                connText.textContent = 'CONNECTED';
            } else {
                wasDisconnected = true;
                banner.classList.remove('hidden', 'restored');
                bannerText.textContent = 'RECONNECTING...';
                statusLed.className = 'status-led offline';
                connText.textContent = 'DISCONNECTED';
            }
        });
    },

    // Called after successful login
    async onLogin(user) {
        console.log('[App] User logged in:', user.displayName);

        try {
            // Join initial channel
            await Channels.joinInitialChannel(user);

            // Start chat
            Chat.startListening(Channels.getCurrentChannel());

            // Join audio
            await PTTAudio.joinChannel(Channels.getCurrentChannel());

            // Start alerts
            Alerts.startListening(Channels.getCurrentChannel());

            // Start recordings
            Recording.startListening();

            // Monitor connection status
            this.monitorConnection();

            // Re-acquire wake lock when tab becomes visible
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && this._wakeLock === null && PTTAudio.currentSpeaker) {
                    this.requestWakeLock();
                }
            });

            // Request notification permission (user gesture context from login)
            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }

            // Add welcome message
            Chat.addSystemMessage(`Welcome, ${user.displayName}! You are now in ${Channels.getChannelName(Channels.getCurrentChannel())}.`);
            Chat.addSystemMessage('Hold SPACEBAR or press the PTT button to talk.');

        } catch (error) {
            console.error('[App] Error during login setup:', error);
        }
    },

    // Show configuration error
    showConfigError() {
        const loginContainer = document.querySelector('.login-container');
        loginContainer.innerHTML = `
            <div class="logo">
                <div class="logo-icon">⚠️</div>
                <h1>SETUP REQUIRED</h1>
            </div>
            <div class="config-error">
                <p>Firebase is not configured yet.</p>
                <p>Please follow these steps:</p>
                <ol>
                    <li>Create a Firebase project at <a href="https://console.firebase.google.com" target="_blank">Firebase Console</a></li>
                    <li>Enable Authentication (Anonymous)</li>
                    <li>Enable Realtime Database</li>
                    <li>Enable Storage</li>
                    <li>Copy your config to <code>js/config.js</code></li>
                    <li>Set your room password in <code>js/config.js</code></li>
                </ol>
                <p>See README.md for detailed instructions.</p>
            </div>
        `;

        // Add some styling for the error
        const style = document.createElement('style');
        style.textContent = `
            .config-error {
                text-align: left;
                padding: 20px;
                background: var(--bg-input);
                border-radius: var(--radius-md);
                margin-top: 20px;
            }
            .config-error p {
                margin-bottom: 10px;
                color: var(--text-secondary);
            }
            .config-error ol {
                margin: 15px 0;
                padding-left: 20px;
            }
            .config-error li {
                margin-bottom: 8px;
                color: var(--text-primary);
            }
            .config-error a {
                color: var(--accent-green);
            }
            .config-error code {
                background: var(--bg-dark);
                padding: 2px 6px;
                border-radius: 3px;
                font-family: var(--font-mono);
                color: var(--accent-green);
            }
        `;
        document.head.appendChild(style);
    }
};

// PWA install prompt
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById('install-btn').classList.remove('hidden');
});

document.addEventListener('DOMContentLoaded', () => {
    App.init();

    // Register service worker for PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Install app button
    document.getElementById('install-btn').addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const result = await deferredInstallPrompt.userChoice;
        if (result.outcome === 'accepted') {
            document.getElementById('install-btn').classList.add('hidden');
        }
        deferredInstallPrompt = null;
    });
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    if (Auth.getUser()) {
        // Cleanup on page close
        Channels.cleanup();
        PTTAudio.cleanup();
    }
});
