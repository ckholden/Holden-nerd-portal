import { onAuthChange, signIn, signOut, getCurrentUser } from './auth.js';
import { ChatSession, renderMessage, appendStreamingMessage } from './chat.js';
import { db } from './firebase-config.js';
import { ref, get, set, onValue, off } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { VoiceRecorder, transcribe, speak, cancelSpeech, getSpanishVoices, unlockAudio, waitForSpeechEnd } from './voice.js';
import { loadScenarios, renderScenarioPicker, renderScenarioBanner, scenarioOpeningPrompt } from './scenarios.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let session = null;
let correctionMode = localStorage.getItem('correctionMode') || 'gentle';
// TTS default OFF — user explicitly toggles it on for spoken replies
let ttsEnabled = localStorage.getItem('ttsEnabled') === 'true';
// Initialize the storage key so isTtsMuted() in voice.js works correctly
if (localStorage.getItem('ttsEnabled') === null) localStorage.setItem('ttsEnabled', 'false');
let ttsVoice = localStorage.getItem('ttsVoice') || null;
let ttsRate = parseFloat(localStorage.getItem('ttsRate') || '0.95');
let recorder = null;
let conversationMode = false;
let conversationAbort = false;
let activeScenario = null;
let scenarioBannerEl = null;

// ---------------------------------------------------------------------------
// DOM refs (assigned after DOMContentLoaded)
// ---------------------------------------------------------------------------

let loginScreen, mainApp, placementScreen;
let loginForm, loginEmail, loginPassword, loginError;
let chatMessages, chatScroll, chatInput, chatSend, chatClear, chatMic, convStartBtn, convOverlay, convStatus, convExitBtn;
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
// Cross-device chat sync via Firebase RTDB
// ---------------------------------------------------------------------------

function buildCloudSync(uid) {
  const sessionRef = ref(db, `users/${uid}/sessions/active`);
  return {
    async save(state) { await set(sessionRef, state); },
    async load() {
      const snap = await get(sessionRef);
      return snap.exists() ? snap.val() : null;
    },
  };
}

let activeSessionListenerOff = null;
function subscribeToActiveSession(uid) {
  if (activeSessionListenerOff) activeSessionListenerOff();
  const sessionRef = ref(db, `users/${uid}/sessions/active`);
  let lastUpdatedAt = session?.messages?.length ? Date.now() : 0;

  const handler = (snap) => {
    if (!snap.exists() || !session) return;
    const cloud = snap.val();
    if (!cloud?.updatedAt || cloud.updatedAt <= lastUpdatedAt) return;

    // Only re-render if message count changed (avoids loops from our own writes)
    if ((cloud.messages?.length ?? 0) === session.messages.length) return;
    if (session._streaming) return; // mid-stream — let it finish

    lastUpdatedAt = cloud.updatedAt;
    session.messages = cloud.messages ?? [];
    session.sessionSummary = cloud.sessionSummary ?? null;

    // Re-render
    chatMessages.innerHTML = '';
    session.messages.forEach((msg) => chatMessages.appendChild(renderMessage(msg)));
    chatScroll.scrollTop = chatScroll.scrollHeight;
  };
  onValue(sessionRef, handler);
  activeSessionListenerOff = () => off(sessionRef, 'value', handler);
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

async function initChat() {
  const user = getCurrentUser();
  const cloudSync = user ? buildCloudSync(user.uid) : null;

  session = new ChatSession({ correctionMode, cloudSync });

  // Restore the most recent session (prefers Firebase = cross-device)
  const restored = await session.restore();
  if (restored) {
    session.messages.forEach((msg) => {
      const el = renderMessage(msg);
      chatMessages.appendChild(el);
    });
    chatScroll.scrollTop = chatScroll.scrollHeight;
    // Hide the welcome bubble if we have history
    document.querySelector('.welcome-message')?.remove();
  }

  // Subscribe to Firebase updates so changes from another device
  // (e.g. you sent a message on your phone) show up in this browser
  if (user) subscribeToActiveSession(user.uid);

  // Send button / Enter key
  chatSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Clear / start over
  chatClear.addEventListener('click', async () => {
    if (!confirm('Start over? Current conversation will be cleared on all your devices.')) return;
    session.clear();
    await session.flushSync();
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

  // Conversation Mode — hands-free, talking back and forth like a real session
  convStartBtn?.addEventListener('click', enterConversationMode);
  convExitBtn?.addEventListener('click', exitConversationMode);

  // Tabs (chat / scenarios — vocab + medical still placeholder)
  initTabs();

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

// ---------------------------------------------------------------------------
// Tab switching + scenario flow
// ---------------------------------------------------------------------------

function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  for (const btn of tabBtns) {
    if (btn.disabled) continue;
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // Enable scenarios tab now that it's built
  const scenariosTabBtn = document.querySelector('.tab-btn[data-tab="scenarios"]');
  if (scenariosTabBtn) {
    scenariosTabBtn.disabled = false;
    scenariosTabBtn.classList.remove('tab-btn--soon');
    scenariosTabBtn.title = 'Real-world Spanish scenarios';
    scenariosTabBtn.addEventListener('click', () => switchTab('scenarios'));
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('tab-btn--active', b.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    const isActive = p.id === `tab-${tabId}`;
    p.classList.toggle('tab-panel--active', isActive);
    p.classList.toggle('hidden', !isActive);
  });
  if (tabId === 'scenarios') openScenariosTab();
}

async function openScenariosTab() {
  const panel = document.getElementById('tab-scenarios');
  if (!panel) return;
  try {
    await loadScenarios();
    renderScenarioPicker(panel, { onSelect: startScenario });
  } catch (err) {
    panel.innerHTML = `<p style="color:var(--text-muted);padding:2rem">Couldn't load scenarios: ${err.message}</p>`;
  }
}

async function startScenario(scenario) {
  activeScenario = scenario;

  // Switch chat session into scenario mode + clear history (fresh stage)
  if (session) {
    session.clear();
    session.mode = 'scenario';
    session.scenario = scenario;
    await session.flushSync();
  }

  // Clear chat UI + remove welcome bubble
  chatMessages.innerHTML = '';

  // Insert scenario banner at top of chat
  scenarioBannerEl = renderScenarioBanner(scenario, { onExit: exitScenario });
  chatMessages.appendChild(scenarioBannerEl);

  // Switch to chat tab
  switchTab('chat');

  // Send a synthetic kickoff so Lupita opens IN CHARACTER
  await sendScenarioKickoff(scenario);
}

async function sendScenarioKickoff(scenario) {
  // Use the scenario opening prompt as the user's first message — but DON'T
  // render it as a user bubble (it's a stage cue, not Christian's words)
  const kickoff = scenarioOpeningPrompt(scenario);
  session.messages.push({ role: 'user', content: kickoff });

  const { appendToken, finalize } = appendStreamingMessage(chatMessages, chatScroll);
  let fullResponse = '';

  session
    .onToken((tok) => { fullResponse += tok; appendToken(tok); })
    .onMessage((full) => {
      finalize(full);
      if (ttsEnabled && full) {
        showTtsStop();
        speak(full, { rate: ttsRate, voiceURI: ttsVoice });
        const t = setInterval(() => {
          if (!window.speechSynthesis?.speaking) { hideTtsStop(); clearInterval(t); }
        }, 300);
      }
    })
    .onError((err) => finalize(`⚠️ ${err.message}`));

  // Send via streamChat directly (the user-message was already pushed)
  // We reuse session.send semantics by hand-crafting the call
  try {
    const stream = (await import('./api.js')).streamChat({
      messages: session.messages,
      mode: 'scenario',
      correctionMode: session.correctionMode,
      scenario,
    });
    session._streaming = true;
    for await (const tok of stream) { fullResponse += tok; appendToken(tok); }
    session.messages.push({ role: 'assistant', content: fullResponse });
    session._streaming = false;
    finalize(fullResponse);
    if (ttsEnabled && fullResponse) speak(fullResponse, { rate: ttsRate, voiceURI: ttsVoice });
    session._persist();
  } catch (err) {
    session._streaming = false;
    finalize(`⚠️ ${err.message}`);
  }
}

function exitScenario() {
  activeScenario = null;
  if (session) {
    session.mode = 'chat';
    session.scenario = null;
  }
  scenarioBannerEl?.remove();
  scenarioBannerEl = null;
}

// ---------------------------------------------------------------------------
// Conversation Mode — hands-free back-and-forth
// ---------------------------------------------------------------------------

function setConvStatus(text, kind = 'idle') {
  if (!convStatus) return;
  convStatus.textContent = text;
  convStatus.dataset.kind = kind; // 'listening' | 'thinking' | 'speaking' | 'idle'
}

async function enterConversationMode() {
  if (conversationMode) return;
  await unlockAudio(); // user gesture — must be inside the click handler call chain
  conversationMode = true;
  conversationAbort = false;
  convOverlay?.classList.remove('hidden');
  setConvStatus('Listening… speak whenever you\'re ready', 'listening');
  conversationLoop();
}

function exitConversationMode() {
  conversationMode = false;
  conversationAbort = true;
  cancelSpeech();
  if (recorder && recorder.state !== 'idle') recorder.cancel();
  convOverlay?.classList.add('hidden');
  hideTtsStop();
}

async function conversationLoop() {
  while (conversationMode && !conversationAbort) {
    try {
      // 1. Listen — auto-stops on silence
      setConvStatus('🎙️ Listening…', 'listening');
      const blob = await listenWithSilenceDetect();
      if (!conversationMode) break;
      if (!blob) {
        // No speech captured — wait briefly and try again
        await sleep(400);
        continue;
      }

      // 2. Transcribe
      setConvStatus('💭 Transcribing…', 'thinking');
      const text = await transcribe(blob);
      if (!conversationMode) break;
      if (!text) { await sleep(400); continue; }

      // 3. Show user message in chat + send
      const userEl = renderMessage({ role: 'user', content: text });
      chatMessages.appendChild(userEl);
      chatScroll.scrollTop = chatScroll.scrollHeight;

      setConvStatus('💭 Lupita is thinking…', 'thinking');

      // 4. Stream Lupita's reply (and capture full text for TTS)
      const { appendToken, finalize } = appendStreamingMessage(chatMessages, chatScroll);
      let fullResponse = '';

      session
        .onToken((tok) => { fullResponse += tok; appendToken(tok); })
        .onMessage((full) => { finalize(full); })
        .onError((err) => { finalize(`⚠️ Error: ${err.message}`); });

      await session.send(text);
      if (!conversationMode) break;

      // 5. Conversation Mode forces speech (it's the voice-only mode)
      if (fullResponse) {
        setConvStatus('🔊 Lupita is speaking…', 'speaking');
        speak(fullResponse, { rate: ttsRate, voiceURI: ttsVoice, force: true });
        await waitForSpeechEnd();
      }
      // Loop back to listening
    } catch (err) {
      console.error('Conversation loop error:', err);
      setConvStatus(`⚠️ ${err.message}`, 'idle');
      await sleep(1500);
    }
  }
}

function listenWithSilenceDetect() {
  return new Promise(async (resolve) => {
    const tempRec = new VoiceRecorder({
      silenceMs: 1500,
      silenceThreshold: 0.012,
      onSilence: async () => {
        const blob = await tempRec.stopAndGetBlob();
        tempRec.reset();
        resolve(blob);
      },
      onStateChange: () => {},
    });
    recorder = tempRec; // expose for cancel()
    try {
      await tempRec.start();
      // Safety net: hard stop after 30s even if silence isn't detected
      setTimeout(async () => {
        if (tempRec.state === 'recording') {
          const blob = await tempRec.stopAndGetBlob();
          tempRec.reset();
          resolve(blob);
        }
      }, 30000);
    } catch (err) {
      tempRec.reset();
      resolve(null);
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      // Speak Lupita's reply IFF user has unmuted (speak() also self-checks as defense-in-depth)
      if (ttsEnabled && full) {
        showTtsStop();
        speak(full, { rate: ttsRate, voiceURI: ttsVoice });
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
  convStartBtn = document.getElementById('conv-start');
  convOverlay = document.getElementById('conv-overlay');
  convStatus = document.getElementById('conv-status');
  convExitBtn = document.getElementById('conv-exit');

  initLoginForm();

  // Persist chat state every 5 seconds (iOS backgrounding recovery)
  setInterval(() => session?._persist(), 5000);
});
