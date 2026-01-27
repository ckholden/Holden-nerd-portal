// ========================================
// MAIN APPLICATION
// ========================================

const App = {
    initialized: false,

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

        this.initialized = true;
        console.log('[App] Initialization complete');
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

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    if (Auth.getUser()) {
        // Cleanup on page close
        Channels.cleanup();
        PTTAudio.cleanup();
    }
});
