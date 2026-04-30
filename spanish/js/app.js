import { onAuthChange, signIn, signOut, getCurrentUser } from './auth.js';
import { ChatSession, renderMessage, appendStreamingMessage } from './chat.js';
import { db } from './firebase-config.js';
import { ref, get, set } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { VoiceRecorder, transcribe, speak, cancelSpeech, getSpanishVoices, unlockAudio } from './voice.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let session = null;
let correctionMode = localStorage.getItem('correctionMode') || 'gentle';
let ttsEnabled = localStorage.getItem('ttsEnabled') !== 'false'; // default ON
let ttsVoice = localStorage.getItem('ttsVoice') || null;
let ttsRate = parseFloat(localStorage.getItem('ttsRate') || '0.95');
let recorder = null;

// ---------------------------------------------------------------------------
// DOM refs (assigned after DOMContentLoaded)
// ---------------------------------------------------------------------------

let loginScreen, mainApp, placementScreen;
let loginForm, loginEmail, loginPassword, loginError;
let chatMessages, chatScroll, chatInput, chatSend, chatClear, chatMic;
let correctionSlider, settingsPanel, settingsToggle;
let ttsToggle, voiceSelect, ttsRateInput, ttsStopBtn, ttsQuickToggle;

function syncTtsToggleUI() {
  if (ttsQuickToggle) {
    ttsQuickToggle.textContent = ttsEnabled ? '🔊' : '🔇';
    ttsQuickToggle.title = ttsEnabled ? 'Voice on — tap to mute' : 'Muted — tap to unmute';
    ttsQuickToggle.classList.toggle('tts-toggle-btn--muted', !ttsEnabled);
  }
  if (ttsToggle) ttsToggle.checked = ttsEnabled;
}

function setTtsEnabled(value) {
  ttsEnabled = !!value;
  localStorage.setItem('ttsEnabled', ttsEnabled);
  if (!ttsEnabled) { cancelSpeech(); hideTtsStop(); }
  syncTtsToggleUI();
}

function showTtsStop() { ttsStopBtn?.classList.remove('hidden'); }
function hideTtsStop() { ttsStopBtn?.classList.add('hidden'); }
let placementMessages, placementScroll;

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

onAuthChange(async (user) => {
  if (!user) {
    showScreen('login');
    return;
  }

  // Check if placement quiz is complete
  try {
    const snap = await get(ref(db, `users/${user.uid}/placement/completed`));
    if (!snap.exists() || !snap.val()) {
      showScreen('placement');
      initPlacement(user);
      return;
    }
  } catch {
    // If we can't read Firebase (rules not set up yet), skip placement
  }

  showScreen('main');
  initChat();
});

function showScreen(name) {
  loginScreen?.classList.toggle('hidden', name !== 'login');
  mainApp?.classList.toggle('hidden', name !== 'main');
  placementScreen?.classList.toggle('hidden', name !== 'placement');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function initLoginForm() {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const btn = loginForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await signIn(loginEmail.value.trim(), loginPassword.value);
    } catch (err) {
      loginError.textContent = friendlyAuthError(err.code);
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/too-many-requests': 'Too many attempts. Try again in a moment.',
    'auth/network-request-failed': 'Network error — check your connection.',
    'auth/configuration-not-found': 'Email/password sign-in not enabled in Firebase Console.',
  };
  return map[code] || `Sign-in failed (${code || 'unknown error'}).`;
}

// ---------------------------------------------------------------------------
// Placement quiz (Phase 1: simple self-assessment form)
// Phase 5 will replace this with a 5-turn Haiku-driven assessment chat
// ---------------------------------------------------------------------------

function initPlacement(user) {
  const form = document.getElementById('placement-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const level = form.querySelector('input[name="level"]:checked')?.value || 'A2';
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;

    try {
      await set(ref(db, `users/${user.uid}/placement`), {
        completed: true,
        level,
        completedAt: Date.now(),
        conceptsToWatch: [],
      });
      await set(ref(db, `users/${user.uid}/learnerModel/proficiency`), {
        overall: level,
        speaking: 0,
        listening: 0,
        lastEstimatedAt: Date.now(),
      });
      showScreen('main');
      initChat();
    } catch (err) {
      btn.disabled = false;
      console.error('Placement save failed', err);
    }
  });
}

// ---------------------------------------------------------------------------
// Main chat
// ---------------------------------------------------------------------------

function initChat() {
  session = new ChatSession({ correctionMode });

  // Try to restore a prior session (iOS PWA state recovery)
  const restored = session.restore();
  if (restored) {
    session.messages.forEach((msg) => {
      const el = renderMessage(msg);
      chatMessages.appendChild(el);
    });
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  // Send button / Enter key
  chatSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Clear / start over
  chatClear.addEventListener('click', () => {
    if (!confirm('Start over? Current conversation will be cleared.')) return;
    session.clear();
    chatMessages.innerHTML = '';
  });

  // Settings panel
  settingsToggle.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));

  // Correction mode slider
  correctionSlider.addEventListener('change', (e) => {
    correctionMode = e.target.value;
    localStorage.setItem('correctionMode', correctionMode);
    session.correctionMode = correctionMode;
  });
  correctionSlider.value = correctionMode;

  // Voice settings — TTS toggle (settings panel) + quick toggle (header)
  syncTtsToggleUI();
  if (ttsToggle) {
    ttsToggle.addEventListener('change', (e) => setTtsEnabled(e.target.checked));
  }
  if (ttsQuickToggle) {
    ttsQuickToggle.addEventListener('click', () => setTtsEnabled(!ttsEnabled));
  }
  if (ttsRateInput) {
    ttsRateInput.value = ttsRate;
    ttsRateInput.addEventListener('change', (e) => {
      ttsRate = parseFloat(e.target.value) || 0.95;
      localStorage.setItem('ttsRate', String(ttsRate));
    });
  }
  populateVoicePicker();

  // Mic button — tap to start, tap to stop
  initMic();

  // Stop Lupita button
  ttsStopBtn?.addEventListener('click', () => {
    cancelSpeech();
    hideTtsStop();
  });

  // Sign out
  document.getElementById('sign-out')?.addEventListener('click', async () => {
    await signOut();
  });
}

async function populateVoicePicker() {
  if (!voiceSelect) return;
  const voices = await getSpanishVoices();
  voiceSelect.innerHTML = '';
  if (voices.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No Spanish voices found on this device';
    opt.disabled = true;
    voiceSelect.appendChild(opt);
    return;
  }
  // Group by region tag in label so MX voices are obvious
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    if (ttsVoice === v.voiceURI) opt.selected = true;
    voiceSelect.appendChild(opt);
  }
  voiceSelect.addEventListener('change', (e) => {
    ttsVoice = e.target.value;
    localStorage.setItem('ttsVoice', ttsVoice);
  });
}

function initMic() {
  if (!chatMic) return;

  recorder = new VoiceRecorder({
    onStateChange: (state) => {
      chatMic.dataset.state = state;
      switch (state) {
        case 'idle':       chatMic.title = 'Tap to record (Spanish or English)'; chatMic.textContent = '🎙️'; break;
        case 'requesting': chatMic.title = 'Requesting microphone…'; chatMic.textContent = '⏳'; break;
        case 'recording':  chatMic.title = 'Tap to stop and send'; chatMic.textContent = '⏹️'; break;
        case 'processing': chatMic.title = 'Transcribing…'; chatMic.textContent = '⏳'; break;
      }
    },
  });

  chatMic.addEventListener('click', async () => {
    // If Lupita is talking, interrupt her — natural conversational flow
    if (window.speechSynthesis?.speaking) {
      cancelSpeech();
      hideTtsStop();
    }

    // Important: this click handler IS the user gesture. AudioContext.resume()
    // and getUserMedia() must be called from inside it (iOS requirement).
    await unlockAudio();

    if (recorder.state === 'idle') {
      try {
        await recorder.start();
      } catch (err) {
        alert(`Microphone error: ${err.message}\n\nMake sure you've granted mic permission.`);
        recorder.reset();
      }
    } else if (recorder.state === 'recording') {
      const blob = await recorder.stopAndGetBlob();
      recorder.reset();
      if (!blob) return;

      try {
        const text = await transcribe(blob);
        if (!text) {
          alert("I didn't catch that — try again.");
          return;
        }
        // Stuff the transcribed text into the input + auto-send
        chatInput.value = text;
        await sendMessage();
      } catch (err) {
        alert(`Transcription failed: ${err.message}`);
      }
    }
  });
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !session) return;

  chatInput.value = '';
  chatInput.disabled = true;
  chatSend.disabled = true;

  // Render user message immediately
  const userEl = renderMessage({ role: 'user', content: text });
  chatMessages.appendChild(userEl);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  // Start streaming assistant response
  const { appendToken, finalize } = appendStreamingMessage(chatMessages, chatScroll);

  let fullResponse = '';

  session
    .onToken((token) => {
      fullResponse += token;
      appendToken(token);
    })
    .onMessage((full) => {
      finalize(full);
      chatInput.disabled = false;
      chatSend.disabled = false;
      chatInput.focus();
      // Auto-play TTS for Lupita's reply (if enabled)
      if (ttsEnabled && full) {
        showTtsStop();
        speak(full, { rate: ttsRate, voiceURI: ttsVoice });
        // Hide stop button when speech finishes naturally
        const checkDone = setInterval(() => {
          if (!window.speechSynthesis?.speaking) {
            hideTtsStop();
            clearInterval(checkDone);
          }
        }, 300);
      }
    })
    .onError((err) => {
      finalize(`⚠️ Error: ${err.message}`);
      chatInput.disabled = false;
      chatSend.disabled = false;
    });

  await session.send(text);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Assign DOM refs
  loginScreen = document.getElementById('login-screen');
  mainApp = document.getElementById('main-app');
  placementScreen = document.getElementById('placement-screen');
  loginForm = document.getElementById('login-form');
  loginEmail = document.getElementById('login-email');
  loginPassword = document.getElementById('login-password');
  loginError = document.getElementById('login-error');
  chatMessages = document.getElementById('chat-messages');
  chatScroll = document.getElementById('chat-scroll');
  chatInput = document.getElementById('chat-input');
  chatSend = document.getElementById('chat-send');
  chatClear = document.getElementById('chat-clear');
  chatMic = document.getElementById('chat-mic');
  correctionSlider = document.getElementById('correction-mode');
  settingsPanel = document.getElementById('settings-panel');
  settingsToggle = document.getElementById('settings-toggle');
  ttsToggle = document.getElementById('tts-enabled');
  voiceSelect = document.getElementById('tts-voice');
  ttsRateInput = document.getElementById('tts-rate');
  ttsStopBtn = document.getElementById('tts-stop');
  ttsQuickToggle = document.getElementById('tts-quick-toggle');

  initLoginForm();

  // Persist chat state every 5 seconds (iOS backgrounding recovery)
  setInterval(() => session?._persist(), 5000);
});
