import { onAuthChange, signIn, signOut, getCurrentUser } from './auth.js';
import { ChatSession, renderMessage, appendStreamingMessage } from './chat.js';
import { db } from './firebase-config.js';
import { ref, get, set, onValue, off } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { VoiceRecorder, transcribe, speak, cancelSpeech, getSpanishVoices, unlockAudio, waitForSpeechEnd, browserSTTAvailable, browserListen, browserListenStop } from './voice.js';
import { loadScenarios, renderScenarioPicker, renderScenarioBanner, scenarioOpeningPrompt } from './scenarios.js';
import { loadMedicalTopics, renderMedicalPicker, renderMedicalBanner, medicalOpeningPrompt } from './medical.js';
import { renderVocabPanel, saveWords } from './vocab.js';
import { renderFocusCard, recordActivity } from './focus.js';
import { renderLessonPlayer, markLessonComplete } from './curriculum.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let session = null;
let correctionMode = localStorage.getItem('correctionMode') || 'gentle';
// Chat mode: 'text' | 'audio' | 'conversation'
// 'text'         → no TTS (read replies)
// 'audio'        → TTS auto-plays replies
// 'conversation' → enters hands-free voice loop overlay
let chatMode = localStorage.getItem('chatMode') || 'text';
let ttsEnabled = chatMode === 'audio'; // derived from mode
// Keep voice.js's isTtsMuted() in sync with the mode
localStorage.setItem('ttsEnabled', String(ttsEnabled));
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
let ttsToggle, voiceSelect, ttsRateInput, ttsStopBtn;
let modePills, historyToggleBtn, historyPanel;

function setChatMode(mode) {
  if (!['text', 'audio', 'conversation'].includes(mode)) mode = 'text';

  // Exit conversation mode if leaving it
  if (chatMode === 'conversation' && mode !== 'conversation') {
    exitConversationMode();
  }

  chatMode = mode;
  ttsEnabled = mode === 'audio';
  localStorage.setItem('chatMode', mode);
  localStorage.setItem('ttsEnabled', String(ttsEnabled));

  // Visual: highlight active pill
  document.querySelectorAll('.mode-pill').forEach((p) => {
    const isActive = p.dataset.mode === mode;
    p.classList.toggle('mode-pill--active', isActive);
    p.setAttribute('aria-selected', String(isActive));
  });

  // If muted, kill any in-flight speech
  if (!ttsEnabled) { cancelSpeech(); hideTtsStop(); }

  // If selecting Conversation Mode, enter the hands-free overlay
  if (mode === 'conversation') enterConversationMode();
}

function showTtsStop() { ttsStopBtn?.classList.remove('hidden'); }
function hideTtsStop() { ttsStopBtn?.classList.add('hidden'); }

// Single shared TTS-end interval (avoids leaks from multiple armings)
let ttsEndInterval = null;
function armTtsEndWatcher() {
  if (ttsEndInterval) clearInterval(ttsEndInterval);
  ttsEndInterval = setInterval(() => {
    if (!window.speechSynthesis?.speaking) {
      hideTtsStop();
      clearInterval(ttsEndInterval);
      ttsEndInterval = null;
    }
  }, 300);
}
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
// Conversation history — archive past sessions, browse, re-open
// ---------------------------------------------------------------------------

async function archiveCurrentSession() {
  if (!session?.messages?.length) return;
  const user = getCurrentUser();
  if (!user) return;
  const archiveId = `${Date.now()}`;
  const firstUser = session.messages.find((m) => m.role === 'user' && !m.content.startsWith('[SCENARIO START') && !m.content.startsWith('[MEDICAL TOPIC START'))?.content || 'Conversation';
  const preview = firstUser.slice(0, 80);
  const archived = {
    archivedAt: Date.now(),
    preview,
    messages: session.messages,
    scenario: session.scenario?.title || session.topic?.title || null,
    mode: session.mode,
  };
  try {
    await set(ref(db, `users/${user.uid}/sessions/history/${archiveId}`), archived);
  } catch (e) {
    console.warn('Archive failed:', e);
  }

  // Fire-and-forget: post-session analysis to update learner model (Phase 5)
  triggerAnalyze(session.messages).catch((e) => console.warn('Analyze failed:', e));
}

async function triggerAnalyze(messages) {
  try {
    const { analyzeSession } = await import('./api.js');
    await analyzeSession(messages);
  } catch (e) {
    // Non-blocking — learner model update failures shouldn't disrupt UX
    console.warn('Analyze:', e.message);
  }
  // Also extract vocab into the bank (parallel, fire-and-forget)
  try {
    const resp = await fetch(`${location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://maestra-lupita-worker.christiankholden.workers.dev'}/extract-vocab`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${await (await import('./auth.js')).getIdToken()}`,
      },
      body: JSON.stringify({ messages }),
    });
    if (resp.ok) {
      const { vocab = [] } = await resp.json();
      if (vocab.length) await saveWords(vocab);
    }
  } catch (e) {
    console.warn('Vocab extract failed:', e.message);
  }
}

// Trigger /analyze on tab hide — but skip if we're mid-stream (would catch a partial reply)
let lastAnalyzeAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden'
      && session?.messages?.length >= 4
      && !session._streaming
      && Date.now() - lastAnalyzeAt > 60_000) {
    lastAnalyzeAt = Date.now();
    triggerAnalyze(session.messages);
  }
});

async function loadHistoryList() {
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const snap = await get(ref(db, `users/${user.uid}/sessions/history`));
    if (!snap.exists()) return [];
    const obj = snap.val();
    return Object.entries(obj)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  } catch {
    return [];
  }
}

async function toggleHistoryPanel() {
  const willOpen = historyPanel?.classList.contains('hidden');
  if (!willOpen) { historyPanel?.classList.add('hidden'); return; }

  // Close settings panel if open
  settingsPanel?.classList.add('hidden');

  const list = document.getElementById('history-list');
  if (list) list.innerHTML = '<p class="history-empty">Loading…</p>';
  historyPanel?.classList.remove('hidden');

  const items = await loadHistoryList();
  if (!list) return;

  if (items.length === 0) {
    list.innerHTML = '<p class="history-empty">No past conversations yet.<br><small>Tap 🗑️ to archive your current chat and start fresh.</small></p>';
    return;
  }

  list.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('button');
    card.className = 'history-item';
    const date = new Date(item.archivedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    card.innerHTML = `
      <div class="history-item__header">
        <span class="history-item__date">${date}</span>
        ${item.scenario ? `<span class="history-item__tag">🎭 ${item.scenario}</span>` : ''}
      </div>
      <div class="history-item__preview">${escapeHtml(item.preview || 'Conversation')}</div>
      <div class="history-item__count">${item.messages?.length || 0} messages</div>
    `;
    card.addEventListener('click', () => openPastSession(item));
    list.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function openPastSession(item) {
  if (!session) return;
  session.messages = item.messages || [];
  session.sessionSummary = null;

  // Restore mode + scenario/topic context if it was a structured session
  session.mode = item.mode || 'chat';
  session.scenario = null;
  session.topic = null;

  await session.flushSync();

  chatMessages.innerHTML = '';
  scenarioBannerEl?.remove();
  scenarioBannerEl = null;

  // Restore scenario/medical banner if applicable (best-effort: match by title)
  if (item.scenario && (item.mode === 'scenario' || item.mode === 'medical')) {
    try {
      if (item.mode === 'scenario') {
        const { loadScenarios, renderScenarioBanner } = await import('./scenarios.js');
        const all = await loadScenarios();
        const match = all.find((s) => s.title === item.scenario);
        if (match) {
          session.scenario = match;
          scenarioBannerEl = renderScenarioBanner(match, { onExit: exitScenario });
          chatMessages.appendChild(scenarioBannerEl);
        }
      } else if (item.mode === 'medical') {
        const { loadMedicalTopics, renderMedicalBanner } = await import('./medical.js');
        const all = await loadMedicalTopics();
        const match = all.find((t) => t.title === item.scenario);
        if (match) {
          session.topic = match;
          scenarioBannerEl = renderMedicalBanner(match, { onExit: exitMedicalTopic });
          chatMessages.appendChild(scenarioBannerEl);
        }
      }
    } catch {}
  }

  session.messages.forEach((msg) => {
    if (msg.role === 'user' && (msg.content.startsWith('[SCENARIO START') || msg.content.startsWith('[MEDICAL TOPIC START'))) return;
    chatMessages.appendChild(renderMessage(msg));
  });
  chatScroll.scrollTop = chatScroll.scrollHeight;
  historyPanel?.classList.add('hidden');
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

let chatInitialized = false;

async function initChat() {
  if (chatInitialized) return; // guard against re-init on auth state changes
  chatInitialized = true;

  const user = getCurrentUser();
  const cloudSync = user ? buildCloudSync(user.uid) : null;

  session = new ChatSession({ correctionMode, cloudSync });

  // Restore the most recent session (prefers Firebase = cross-device)
  const restored = await session.restore();
  if (restored) {
    document.querySelector('.welcome-message')?.remove();
    session.messages.forEach((msg) => {
      if (msg.role === 'user' && (msg.content.startsWith('[SCENARIO START') || msg.content.startsWith('[MEDICAL TOPIC START'))) return;
      chatMessages.appendChild(renderMessage(msg));
    });
    chatScroll.scrollTop = chatScroll.scrollHeight;
  } else {
    // Empty chat → show Today's Focus card with "Start today's lesson" CTA
    document.querySelector('.welcome-message')?.remove();
    await renderFocusCard(chatMessages, {
      onChip: ({ action, prompt, tab, mode: lessonMode }, todaysLesson) => {
        if (action === 'review-cards') switchTab('vocab');
        else if (action === 'goto-tab' && tab) switchTab(tab);
        else if (action === 'quickstart' && prompt) { chatInput.value = prompt; sendMessage(); }
        else if (action === 'start-lesson' && todaysLesson) startLesson(todaysLesson, lessonMode || 'quick');
      },
    }).catch((e) => console.warn('Focus card failed:', e));
  }

  // Subscribe to Firebase updates so changes from another device
  // (e.g. you sent a message on your phone) show up in this browser
  if (user) subscribeToActiveSession(user.uid);

  // Send button / Enter key
  chatSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Auto-grow textarea up to 6 lines (#33)
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
  });

  // iOS keyboard scroll fix (#28) — when keyboard pushes layout, scroll chat to bottom
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      requestAnimationFrame(() => { chatScroll.scrollTop = chatScroll.scrollHeight; });
    });
  }

  // Clear / start over — also archives current conversation to history
  chatClear.addEventListener('click', async () => {
    if (!confirm('Start a new conversation? The current one will be saved to history.')) return;
    await archiveCurrentSession();
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

  // 3-mode chat pills (Text / Voice / Talk)
  modePills?.forEach((pill) => {
    pill.addEventListener('click', () => setChatMode(pill.dataset.mode));
  });
  // Sync UI to current mode (without re-entering Conversation if already there)
  document.querySelectorAll('.mode-pill').forEach((p) => {
    const isActive = p.dataset.mode === chatMode;
    p.classList.toggle('mode-pill--active', isActive);
    p.setAttribute('aria-selected', String(isActive));
  });

  // Settings panel TTS checkbox kept as a backup (mirrors mode)
  if (ttsToggle) {
    ttsToggle.checked = ttsEnabled;
    ttsToggle.addEventListener('change', (e) => setChatMode(e.target.checked ? 'audio' : 'text'));
  }

  // History panel
  historyToggleBtn?.addEventListener('click', toggleHistoryPanel);
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

  // If a previous session marked Whisper as unavailable, default to browser STT
  let useBrowserSTT = localStorage.getItem('useBrowserSTT') === 'true' && browserSTTAvailable();
  let browserListening = false;

  chatMic.addEventListener('click', async () => {
    if (window.speechSynthesis?.speaking) { cancelSpeech(); hideTtsStop(); }
    await unlockAudio();

    // ── Browser SpeechRecognition fallback path
    if (useBrowserSTT) {
      if (browserListening) {
        browserListenStop();
        return;
      }
      browserListening = true;
      chatMic.dataset.state = 'recording';
      chatMic.textContent = '⏹️';
      chatMic.title = 'Tap to stop';
      try {
        const text = await browserListen({ language: 'es-MX', timeoutMs: 30000 });
        if (text) {
          chatInput.value = text;
          await sendMessage();
        } else {
          toast("I didn't catch that — try again", { timeout: 3000 });
        }
      } catch (err) {
        if (err.message !== 'no-speech') {
          toast(`Voice error: ${err.message}`, { kind: 'error', timeout: 4000 });
        }
      } finally {
        browserListening = false;
        chatMic.dataset.state = 'idle';
        chatMic.textContent = '🎙️';
        chatMic.title = 'Tap to record (browser voice)';
      }
      return;
    }

    // ── Whisper path (default)
    if (recorder.state === 'idle') {
      try {
        await recorder.start();
      } catch (err) {
        toast(`Microphone error — check permission`, { kind: 'error', timeout: 4000 });
        recorder.reset();
      }
    } else if (recorder.state === 'recording') {
      const blob = await recorder.stopAndGetBlob();
      recorder.reset();
      if (!blob) return;

      try {
        const text = await transcribe(blob);
        if (!text) {
          toast("I didn't catch that — try again", { timeout: 3000 });
          return;
        }
        chatInput.value = text;
        await sendMessage();
      } catch (err) {
        // If Whisper is out of quota, auto-fall back to browser STT for future taps
        if (err.quotaExceeded && browserSTTAvailable()) {
          useBrowserSTT = true;
          localStorage.setItem('useBrowserSTT', 'true');
          toast('Switched to free browser voice. Tap mic to retry.', { kind: 'info', timeout: 5000 });
        } else if (err.quotaExceeded) {
          toast('Voice unavailable — add OpenAI credits at platform.openai.com/billing', { kind: 'error', timeout: 6000 });
        } else {
          toast(friendlyTranscribeError(err.message), { kind: 'error', timeout: 5000 });
        }
      }
    }
  });
}

function friendlyTranscribeError(raw) {
  if (/quota/i.test(raw)) return 'Voice input unavailable — OpenAI quota exceeded. Add credits at platform.openai.com/billing';
  if (/rate.?limit/i.test(raw) || /429/.test(raw)) return 'Voice input rate-limited — wait a moment and retry';
  if (/network|fetch|connection/i.test(raw)) return 'Network error — check your connection';
  if (/401|403|unauth/i.test(raw)) return 'Voice input authentication failed — try signing out and back in';
  return "Couldn't transcribe — try again, or type instead";
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

  // Enable Scenarios + Medical + Vocab tabs (built phases)
  for (const id of ['scenarios', 'medical', 'vocab']) {
    const btn = document.querySelector(`.tab-btn[data-tab="${id}"]`);
    if (!btn) continue;
    btn.disabled = false;
    btn.classList.remove('tab-btn--soon');
    btn.addEventListener('click', () => switchTab(id));
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
  if (tabId === 'medical') openMedicalTab();
  if (tabId === 'vocab') openVocabTab();
}

async function openVocabTab() {
  const panel = document.getElementById('tab-vocab');
  if (!panel) return;
  await renderVocabPanel(panel);
}

async function openMedicalTab() {
  const panel = document.getElementById('tab-medical');
  if (!panel) return;
  try {
    await loadMedicalTopics();
    renderMedicalPicker(panel, { onSelect: startMedicalTopic });
  } catch (err) {
    panel.innerHTML = `<p style="color:var(--text-muted);padding:2rem">Couldn't load topics: ${err.message}</p>`;
  }
}

async function startMedicalTopic(topic) {
  await archiveCurrentSession();

  if (session) {
    session.clear();
    session.mode = 'medical';
    session.topic = topic;
    session.scenario = null;
    await session.flushSync();
  }

  chatMessages.innerHTML = '';
  scenarioBannerEl?.remove();
  scenarioBannerEl = renderMedicalBanner(topic, { onExit: exitMedicalTopic });
  chatMessages.appendChild(scenarioBannerEl);

  switchTab('chat');

  await sendMedicalKickoff(topic);
}

async function sendMedicalKickoff(topic) {
  const kickoff = medicalOpeningPrompt(topic);
  session.messages.push({ role: 'user', content: kickoff });
  await runStreamedKickoff({ mode: 'medical', topic });
}

/** Shared streamed-kickoff runner — single source of truth, no leaked handlers. */
async function runStreamedKickoff({ mode, scenario = null, topic = null, lesson = null }) {
  const { appendToken, finalize, showThinking } = appendStreamingMessage(chatMessages, chatScroll);
  showThinking?.();
  let fullResponse = '';
  session._streaming = true;
  try {
    const { streamChat } = await import('./api.js');
    const stream = streamChat({
      messages: session.messages,
      mode,
      correctionMode: session.correctionMode,
      scenario,
      topic,
      lesson,
    });
    let firstToken = true;
    for await (const tok of stream) {
      if (firstToken) { firstToken = false; }
      fullResponse += tok;
      appendToken(tok);
    }
    session.messages.push({ role: 'assistant', content: fullResponse });
    finalize(fullResponse);
    if (ttsEnabled && fullResponse) {
      showTtsStop();
      speak(fullResponse, { rate: ttsRate, voiceURI: ttsVoice });
      armTtsEndWatcher();
    }
    session._persist();
  } catch (err) {
    finalize(`⚠️ ${err.message}`);
  } finally {
    session._streaming = false;
  }
}

function exitMedicalTopic() {
  if (session) {
    session.mode = 'chat';
    session.topic = null;
  }
  scenarioBannerEl?.remove();
  scenarioBannerEl = null;
}

// ---------------------------------------------------------------------------
// Lesson player launch + practice kickoff
// ---------------------------------------------------------------------------

let activeLesson = null;
let lessonResumeBtn = null;

async function startLesson(lesson, mode = 'quick') {
  activeLesson = { lesson, mode };
  // Render the lesson player INSIDE the chat-messages area (replaces focus card)
  chatMessages.innerHTML = '';
  scenarioBannerEl?.remove();
  scenarioBannerEl = null;

  // Hide the input footer while in lesson player (chat happens at "practice" step)
  document.querySelector('.chat-footer')?.classList.add('hidden');

  renderLessonPlayer(chatMessages, {
    lesson,
    mode,
    onSendMessage: (text, opts) => {
      // User clicked "Start practice with Lupita" inside the lesson player
      // Set chat session into lesson mode and inject the prompt as a kickoff
      activeLesson = { ...activeLesson, atStep: 'practice' };
      kickoffLessonPractice(lesson, text, mode);
    },
    onComplete: async (score) => {
      try { await markLessonComplete(lesson.id, score, mode); } catch {}
      activeLesson = null;
      hideLessonResumeBtn();
      document.querySelector('.chat-footer')?.classList.remove('hidden');
      // Reload focus card so the next lesson shows
      chatMessages.innerHTML = '';
      await renderFocusCard(chatMessages, {
        onChip: focusCardChipHandler,
      }).catch(() => {});
    },
    onExit: () => {
      activeLesson = null;
      hideLessonResumeBtn();
      document.querySelector('.chat-footer')?.classList.remove('hidden');
      chatMessages.innerHTML = '';
      renderFocusCard(chatMessages, { onChip: focusCardChipHandler }).catch(() => {});
    },
  });
}

function focusCardChipHandler({ action, prompt, tab, mode: lessonMode }, todaysLesson) {
  if (action === 'review-cards') switchTab('vocab');
  else if (action === 'goto-tab' && tab) switchTab(tab);
  else if (action === 'quickstart' && prompt) { chatInput.value = prompt; sendMessage(); }
  else if (action === 'start-lesson' && todaysLesson) startLesson(todaysLesson, lessonMode || 'quick');
}

async function kickoffLessonPractice(lesson, prompt, mode) {
  // Hide the lesson player UI; show the chat
  chatMessages.innerHTML = '';
  document.querySelector('.chat-footer')?.classList.remove('hidden');

  // Floating "Resume lesson" button so user can come back after practice
  showLessonResumeBtn(() => {
    if (activeLesson) startLesson(activeLesson.lesson, activeLesson.mode);
  });

  // Configure session for lesson mode + push the prompt as a kickoff
  if (session) {
    session.clear();
    session.mode = 'lesson';
    session.lesson = lesson;
    session.scenario = null;
    session.topic = null;
    await session.flushSync();
  }

  const kickoff = `[LESSON START — ${lesson.title}. Begin the practice activity now: "${prompt}". Stay in character if it's a roleplay. Use the lesson vocabulary naturally.]`;
  session.messages.push({ role: 'user', content: kickoff });
  await runStreamedKickoff({ mode: 'lesson', lesson });
}

function showLessonResumeBtn(onClick) {
  hideLessonResumeBtn();
  lessonResumeBtn = document.createElement('button');
  lessonResumeBtn.className = 'lesson-resume-btn';
  lessonResumeBtn.innerHTML = '📘 Resume lesson →';
  lessonResumeBtn.addEventListener('click', onClick);
  document.getElementById('tab-chat')?.appendChild(lessonResumeBtn);
}

function hideLessonResumeBtn() {
  lessonResumeBtn?.remove();
  lessonResumeBtn = null;
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
  const kickoff = scenarioOpeningPrompt(scenario);
  session.messages.push({ role: 'user', content: kickoff });
  await runStreamedKickoff({ mode: 'scenario', scenario });
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
  // Sync the pulse indicator's color/speed
  document.querySelector('.talk-bar__pulse')?.setAttribute('data-kind', kind);
}

async function enterConversationMode() {
  if (conversationMode) return;
  await unlockAudio();
  conversationMode = true;
  conversationAbort = false;

  // Swap chat-footer ↔ talk-bar so the chat above stays visible
  document.querySelector('.chat-footer')?.classList.add('hidden');
  convOverlay?.classList.remove('hidden');

  setConvStatus('Listening…', 'listening');
  conversationLoop();
}

function exitConversationMode() {
  conversationMode = false;
  conversationAbort = true;
  cancelSpeech();
  if (recorder && recorder.state !== 'idle') recorder.cancel();
  convOverlay?.classList.add('hidden');
  document.querySelector('.chat-footer')?.classList.remove('hidden');
  hideTtsStop();
}

async function conversationLoop() {
  while (conversationMode && !conversationAbort) {
    try {
      // 1. Listen — auto-stops on silence (or manual Send button)
      setConvStatus('Listening…', 'listening');
      const blob = await listenWithSilenceDetect();
      if (!conversationMode) break;
      if (!blob) {
        // No speech captured — wait briefly and try again
        await sleep(400);
        continue;
      }

      // 2. Transcribe
      setConvStatus('Transcribing…', 'thinking');
      let text;
      try {
        text = await transcribe(blob);
      } catch (err) {
        if (err.quotaExceeded) {
          setConvStatus('Voice unavailable — add OpenAI credits', 'idle');
          await sleep(2500);
          break;
        }
        setConvStatus(`Error: ${err.message}`, 'idle');
        await sleep(1500);
        continue;
      }
      if (!conversationMode) break;
      if (!text) {
        setConvStatus("Didn't catch that — try again", 'idle');
        await sleep(1200);
        continue;
      }

      // 3. Show user message in chat + send
      const userEl = renderMessage({ role: 'user', content: text });
      chatMessages.appendChild(userEl);
      chatScroll.scrollTop = chatScroll.scrollHeight;

      setConvStatus('Lupita is thinking…', 'thinking');

      // 4. Stream Lupita's reply (and capture full text for TTS)
      const { appendToken, finalize, showThinking } = appendStreamingMessage(chatMessages, chatScroll);
      showThinking?.();
      let fullResponse = '';

      session
        .onToken((tok) => { fullResponse += tok; appendToken(tok); })
        .onMessage((full) => { finalize(full); })
        .onError((err) => { finalize(`⚠️ Error: ${err.message}`); });

      await session.send(text);
      if (!conversationMode) break;

      // 5. Conversation Mode forces speech (voice-only mode)
      if (fullResponse) {
        setConvStatus('Lupita is speaking…', 'speaking');
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
    let resolved = false;
    let timer = null;
    const stopBtn = document.getElementById('conv-stop-listening');

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      stopBtn?.removeEventListener('click', stopHandler);
    };

    const finish = async () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const blob = await tempRec.stopAndGetBlob().catch(() => null);
      tempRec.reset();
      resolve(blob);
    };

    const stopHandler = () => finish();

    const tempRec = new VoiceRecorder({
      silenceMs: 1500,
      silenceThreshold: 0.006, // lowered from 0.012 — sensitive to quiet speakers
      onSilence: finish,
      onStateChange: () => {},
    });
    recorder = tempRec;

    stopBtn?.addEventListener('click', stopHandler);

    try {
      await tempRec.start();
      timer = setTimeout(finish, 30000); // safety net if user never speaks
    } catch (err) {
      cleanup();
      tempRec.reset();
      setConvStatus(`Mic error: ${err.message}`, 'idle');
      resolved = true;
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

  // Record streak activity (first send of the day increments)
  recordActivity().catch(() => {});

  // Clear focus card if present
  document.querySelector('.focus-card')?.remove();

  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatInput.disabled = true;
  chatSend.disabled = true;

  // Render user message immediately
  const userEl = renderMessage({ role: 'user', content: text });
  chatMessages.appendChild(userEl);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  // Start streaming assistant response (with typing indicator until first token)
  const { appendToken, finalize, showThinking } = appendStreamingMessage(chatMessages, chatScroll);
  showThinking();

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
      if (window.matchMedia('(min-width: 601px)').matches) chatInput.focus(); // skip on mobile
      if (ttsEnabled && full) {
        showTtsStop();
        speak(full, { rate: ttsRate, voiceURI: ttsVoice });
        armTtsEndWatcher();
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

// Register service worker for PWA install + offline shell
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW registration failed:', e));
  });
}

// ---------------------------------------------------------------------------
// Toast — small auto-dismissing notification (replaces alert/confirm/prompt)
// ---------------------------------------------------------------------------

export function toast(msg, { kind = 'info', timeout = 3000 } = {}) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--show'));
  setTimeout(() => {
    el.classList.remove('toast--show');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

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
  modePills = document.querySelectorAll('.mode-pill');
  historyToggleBtn = document.getElementById('history-toggle');
  historyPanel = document.getElementById('history-panel');
  convStartBtn = document.getElementById('conv-start');
  convOverlay = document.getElementById('conv-overlay');
  convStatus = document.getElementById('conv-status');
  convExitBtn = document.getElementById('conv-exit');

  initLoginForm();

  // Persist chat state every 5 seconds (iOS backgrounding recovery)
  setInterval(() => session?._persist(), 5000);
});
