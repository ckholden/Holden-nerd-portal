// ========================================
// AUTHENTICATION MODULE
// ========================================

const Auth = {
    currentUser: null,
    userId: null,

    // Initialize authentication
    init() {
        console.log('[Auth] Initializing...');

        // Check for remembered name
        const rememberedName = localStorage.getItem('holdenptt_callsign');
        if (rememberedName) {
            document.getElementById('display-name').value = rememberedName;
            document.getElementById('remember-me').checked = true;
        }

        // Setup form submission
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });

        // Setup logout button
        document.getElementById('logout-btn').addEventListener('click', () => {
            this.logout();
        });

        // Listen for auth state changes
        auth.onAuthStateChanged((user) => {
            if (user && this.currentUser) {
                console.log('[Auth] User authenticated:', user.uid);
                this.userId = user.uid;
            }
        });
    },

    // Login with display name and room password
    async login() {
        const displayName = document.getElementById('display-name').value.trim();
        const roomPassword = document.getElementById('room-password').value;
        const rememberMe = document.getElementById('remember-me').checked;
        const errorEl = document.getElementById('login-error');

        // Validate inputs
        if (!displayName) {
            errorEl.textContent = 'Please enter your callsign';
            return;
        }

        if (displayName.length < 2 || displayName.length > 20) {
            errorEl.textContent = 'Callsign must be 2-20 characters';
            return;
        }

        // Check room password
        if (roomPassword !== ROOM_PASSWORD) {
            errorEl.textContent = 'Invalid room access code';
            return;
        }

        errorEl.textContent = '';

        try {
            // Sign in anonymously with Firebase
            const credential = await auth.signInAnonymously();
            this.userId = credential.user.uid;
            this.currentUser = {
                uid: this.userId,
                displayName: displayName
            };

            // Remember callsign if requested
            if (rememberMe) {
                localStorage.setItem('holdenptt_callsign', displayName);
            } else {
                localStorage.removeItem('holdenptt_callsign');
            }

            console.log('[Auth] Login successful:', displayName);

            // Update UI
            document.getElementById('user-callsign').textContent = displayName;

            // Switch to app screen
            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('app-screen').classList.remove('hidden');

            // Trigger app initialization
            if (typeof App !== 'undefined' && App.onLogin) {
                App.onLogin(this.currentUser);
            }

        } catch (error) {
            console.error('[Auth] Login error:', error);
            errorEl.textContent = 'Connection failed. Please try again.';
        }
    },

    // Logout and cleanup
    async logout() {
        console.log('[Auth] Logging out...');

        try {
            // Cleanup presence and channels
            if (typeof Channels !== 'undefined') {
                await Channels.cleanup();
            }

            // Cleanup audio
            if (typeof PTTAudio !== 'undefined') {
                await PTTAudio.cleanup();
            }

            // Sign out from Firebase
            await auth.signOut();

            this.currentUser = null;
            this.userId = null;

            // Switch to login screen
            document.getElementById('app-screen').classList.add('hidden');
            document.getElementById('login-screen').classList.remove('hidden');

            // Clear password field
            document.getElementById('room-password').value = '';

            console.log('[Auth] Logout complete');

        } catch (error) {
            console.error('[Auth] Logout error:', error);
        }
    },

    // Get current user info
    getUser() {
        return this.currentUser;
    },

    // Get user ID
    getUserId() {
        return this.userId;
    }
};
