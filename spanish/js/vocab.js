// Vocabulary flashcards with SRS-lite scheduling.
// Cards live in Firebase RTDB at /users/{uid}/vocab/{wordId}.
// Schedule: 1d → 3d → 7d → 14d → 30d → 90d. Wrong answer drops to 1d.

import { db } from './firebase-config.js';
import { ref, get, set, push, remove } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { getCurrentUser, getIdToken } from './auth.js';
import { speak, VoiceRecorder, unlockAudio } from './voice.js';

const WORKER_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8787'
  : 'https://maestra-lupita-worker.christiankholden.workers.dev';

const SRS_INTERVALS = [1, 3, 7, 14, 30, 90]; // days

function vocabRef(uid) { return ref(db, `users/${uid}/vocab`); }
function wordRef(uid, id) { return ref(db, `users/${uid}/vocab/${id}`); }

export async function loadVocabBank() {
  const user = getCurrentUser();
  if (!user) return [];
  try {
    const snap = await get(vocabRef(user.uid));
    if (!snap.exists()) return [];
    const obj = snap.val();
    return Object.entries(obj).map(([id, v]) => ({ id, ...v }));
  } catch {
    return [];
  }
}

/** Save a single new word. Idempotent on Spanish text. */
export async function saveWord({ spanish, english, partOfSpeech = 'word', category = 'general', example = '' }) {
  const user = getCurrentUser();
  if (!user || !spanish?.trim()) return null;

  const existing = await loadVocabBank();
  const dup = existing.find((w) => w.spanish.toLowerCase().trim() === spanish.toLowerCase().trim());
  if (dup) return dup;

  const newRef = push(vocabRef(user.uid));
  const card = {
    spanish: spanish.trim(),
    english: english?.trim() || '',
    partOfSpeech,
    category,
    example: example?.trim() || '',
    addedAt: Date.now(),
    intervalIdx: 0, // index into SRS_INTERVALS
    nextReview: Date.now() + SRS_INTERVALS[0] * 86400000,
    timesSeen: 0,
    timesCorrect: 0,
    lapses: 0,
  };
  await set(newRef, card);
  return { id: newRef.key, ...card };
}

/** Save many at once (used by post-session vocab extraction). */
export async function saveWords(items) {
  const results = [];
  for (const item of items) {
    const saved = await saveWord(item);
    if (saved) results.push(saved);
  }
  return results;
}

export async function deleteWord(id) {
  const user = getCurrentUser();
  if (!user) return;
  await remove(wordRef(user.uid, id));
}

/** Update card's SRS state after a review. quality: 'forgot' | 'hard' | 'easy' */
export async function reviewWord(id, quality) {
  const user = getCurrentUser();
  if (!user) return;
  const snap = await get(wordRef(user.uid, id));
  if (!snap.exists()) return;
  const card = snap.val();

  card.timesSeen = (card.timesSeen || 0) + 1;

  if (quality === 'forgot') {
    card.lapses = (card.lapses || 0) + 1;
    card.intervalIdx = 0;
  } else if (quality === 'hard') {
    card.intervalIdx = Math.max(0, (card.intervalIdx || 0) - 1);
    card.timesCorrect = (card.timesCorrect || 0) + 1;
  } else {
    // easy
    card.intervalIdx = Math.min(SRS_INTERVALS.length - 1, (card.intervalIdx || 0) + 1);
    card.timesCorrect = (card.timesCorrect || 0) + 1;
  }

  card.nextReview = Date.now() + SRS_INTERVALS[card.intervalIdx] * 86400000;
  card.lastReviewedAt = Date.now();

  await set(wordRef(user.uid, id), card);
  return card;
}

/** Get cards due for review now (sorted oldest-due first). */
export function getDueCards(bank) {
  const now = Date.now();
  return bank
    .filter((c) => (c.nextReview ?? 0) <= now)
    .sort((a, b) => (a.nextReview ?? 0) - (b.nextReview ?? 0));
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

const CATEGORY_COLORS = {
  slang:    '#9b59b6',
  medical:  '#5bc0de',
  scenario: '#5cb85c',
  general:  '#888',
};

export async function renderVocabPanel(container) {
  container.innerHTML = `
    <div class="vocab-panel">
      <div class="vocab-header">
        <div>
          <h2>Vocabulary</h2>
          <p id="vocab-stats" class="vocab-stats">Loading…</p>
        </div>
        <button id="vocab-add-btn" class="btn btn--primary btn--small">+ Add word</button>
      </div>
      <div id="vocab-cta" class="vocab-cta hidden"></div>
      <div id="vocab-list" class="vocab-list"></div>
    </div>
  `;

  const bank = await loadVocabBank();
  const due = getDueCards(bank);

  const stats = container.querySelector('#vocab-stats');
  stats.textContent = bank.length === 0
    ? 'No words yet. They\'ll appear here as Lupita teaches you new vocab.'
    : `${bank.length} word${bank.length === 1 ? '' : 's'} · ${due.length} due now`;

  // Review CTA
  const cta = container.querySelector('#vocab-cta');
  if (due.length > 0) {
    cta.classList.remove('hidden');
    cta.innerHTML = `
      <button id="vocab-review-btn" class="btn btn--primary vocab-review-btn">
        🃏 Review ${due.length} card${due.length === 1 ? '' : 's'}
      </button>
    `;
    cta.querySelector('#vocab-review-btn').addEventListener('click', () => startReviewSession(container, due));
  }

  // Add manually
  container.querySelector('#vocab-add-btn').addEventListener('click', () => promptAddWord(container));

  // List
  const list = container.querySelector('#vocab-list');
  if (bank.length === 0) {
    list.innerHTML = '<p class="vocab-empty">After a chat, words you encountered will appear here.</p>';
  } else {
    bank
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .forEach((card) => list.appendChild(renderCardRow(card, container)));
  }
}

function renderCardRow(card, container) {
  const row = document.createElement('div');
  row.className = 'vocab-row';
  const dueIn = (card.nextReview ?? 0) - Date.now();
  const dueLabel = dueIn <= 0 ? 'Due now' : `In ${Math.ceil(dueIn / 86400000)}d`;
  const catColor = CATEGORY_COLORS[card.category] || CATEGORY_COLORS.general;

  row.innerHTML = `
    <div class="vocab-row__main">
      <div class="vocab-row__title">
        <span class="vocab-row__spanish">${escapeHtml(card.spanish)}</span>
        <span class="vocab-row__cat" style="background:${catColor}">${card.category}</span>
      </div>
      <div class="vocab-row__english">${escapeHtml(card.english || '—')}</div>
      ${card.example ? `<div class="vocab-row__example">${escapeHtml(card.example)}</div>` : ''}
      <div class="vocab-row__meta">
        <span>${dueLabel}</span>
        <span>·</span>
        <span>Seen ${card.timesSeen || 0}×</span>
      </div>
    </div>
    <div class="vocab-row__actions">
      <button class="icon-btn" data-action="speak" aria-label="Pronounce" title="Pronounce">🔊</button>
      <button class="icon-btn" data-action="delete" aria-label="Delete" title="Delete">🗑️</button>
    </div>
  `;

  row.querySelector('[data-action="speak"]').addEventListener('click', () => {
    speak(card.spanish, { force: true });
  });
  row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete "${card.spanish}"?`)) return;
    await deleteWord(card.id);
    renderVocabPanel(container);
  });

  return row;
}

async function promptAddWord(container) {
  const spanish = prompt('Spanish word or phrase:');
  if (!spanish?.trim()) return;
  const english = prompt(`English translation for "${spanish}":`) || '';
  await saveWord({ spanish, english, category: 'general' });
  renderVocabPanel(container);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Review session — flashcard UI
// ---------------------------------------------------------------------------

function startReviewSession(container, queue) {
  let idx = 0;
  let revealed = false;

  container.innerHTML = `
    <div class="flashcard-session">
      <div class="flashcard-progress">
        <span id="fc-progress-text">1 / ${queue.length}</span>
        <button id="fc-exit" class="btn btn--ghost btn--small">End review</button>
      </div>
      <div id="flashcard" class="flashcard">
        <div class="flashcard__inner">
          <div class="flashcard__face flashcard__face--front">
            <div class="flashcard__cat" id="fc-cat"></div>
            <div class="flashcard__spanish" id="fc-spanish"></div>
            <button class="btn btn--ghost flashcard__hint" id="fc-speak">🔊 Pronounce</button>
            <button class="btn btn--primary" id="fc-flip">Show meaning</button>
          </div>
          <div class="flashcard__face flashcard__face--back">
            <div class="flashcard__english" id="fc-english"></div>
            <div class="flashcard__example" id="fc-example"></div>
            <button class="btn btn--ghost flashcard__hint" id="fc-pronounce">🎤 Practice pronunciation</button>
            <div id="fc-pron-result" class="flashcard__pron-result hidden"></div>
            <div class="flashcard__buttons">
              <button class="btn flashcard__btn flashcard__btn--forgot" data-q="forgot">Forgot</button>
              <button class="btn flashcard__btn flashcard__btn--hard" data-q="hard">Hard</button>
              <button class="btn flashcard__btn flashcard__btn--easy" data-q="easy">Easy</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  function paint() {
    const card = queue[idx];
    container.querySelector('#fc-progress-text').textContent = `${idx + 1} / ${queue.length}`;
    container.querySelector('#fc-cat').textContent = card.category;
    container.querySelector('#fc-cat').style.background = CATEGORY_COLORS[card.category] || CATEGORY_COLORS.general;
    container.querySelector('#fc-spanish').textContent = card.spanish;
    container.querySelector('#fc-english').textContent = card.english || '—';
    container.querySelector('#fc-example').textContent = card.example || '';
    container.querySelector('#flashcard').classList.toggle('flashcard--flipped', false);
    revealed = false;
  }

  container.querySelector('#fc-flip').addEventListener('click', () => {
    container.querySelector('#flashcard').classList.add('flashcard--flipped');
    revealed = true;
  });

  container.querySelector('#fc-speak').addEventListener('click', () => {
    speak(queue[idx].spanish, { force: true });
  });

  // Pronunciation practice (Phase 8)
  const pronBtn = container.querySelector('#fc-pronounce');
  const pronResult = container.querySelector('#fc-pron-result');
  let recorder = null;
  pronBtn?.addEventListener('click', async () => {
    if (!recorder) {
      // Start recording
      await unlockAudio();
      recorder = new VoiceRecorder();
      try {
        await recorder.start();
        pronBtn.textContent = '⏹️ Tap to score';
        pronBtn.classList.add('flashcard__hint--recording');
        pronResult.classList.add('hidden');
      } catch (err) {
        recorder = null;
        pronResult.classList.remove('hidden');
        pronResult.innerHTML = `<span style="color:#d9534f">Mic error: ${err.message}</span>`;
      }
    } else {
      // Stop + grade
      const blob = await recorder.stopAndGetBlob();
      recorder.reset();
      recorder = null;
      pronBtn.textContent = '⏳ Grading…';
      pronBtn.classList.remove('flashcard__hint--recording');

      try {
        const grade = await gradePronunciation(queue[idx].spanish, blob);
        showPronResult(pronResult, grade);
      } catch (err) {
        pronResult.classList.remove('hidden');
        pronResult.innerHTML = `<span style="color:#d9534f">Grading failed: ${err.message}</span>`;
      } finally {
        pronBtn.textContent = '🎤 Try again';
      }
    }
  });

  container.querySelector('#fc-exit').addEventListener('click', () => {
    renderVocabPanel(container);
  });

  container.querySelectorAll('.flashcard__btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!revealed) return;
      await reviewWord(queue[idx].id, btn.dataset.q);
      idx++;
      if (idx >= queue.length) {
        container.innerHTML = `
          <div class="vocab-done">
            <div class="vocab-done__emoji">🎉</div>
            <h2>Review complete!</h2>
            <p>${queue.length} card${queue.length === 1 ? '' : 's'} reviewed.</p>
            <button id="fc-back" class="btn btn--primary">Back to vocab</button>
          </div>
        `;
        container.querySelector('#fc-back').addEventListener('click', () => renderVocabPanel(container));
      } else {
        paint();
      }
    });
  });

  paint();
}

async function gradePronunciation(target, audioBlob) {
  if (!audioBlob) throw new Error('No audio captured');
  const fd = new FormData();
  fd.append('audio', audioBlob, 'practice.webm');
  fd.append('target', target);
  const token = await getIdToken();
  const resp = await fetch(`${WORKER_BASE}/grade-pronunciation`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: fd,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || 'Grade failed');
  }
  return resp.json();
}

function showPronResult(el, grade) {
  el.classList.remove('hidden');
  const score = grade.score ?? 0;
  const color = score >= 85 ? '#5cb85c' : score >= 65 ? '#f0ad4e' : '#d9534f';
  const emoji = score >= 85 ? '🌟' : score >= 65 ? '👍' : '🔁';
  el.innerHTML = `
    <div class="pron-score" style="color:${color}">${emoji} ${score}/100</div>
    <div class="pron-feedback">${escapeHtml(grade.feedback || '')}</div>
    ${grade.heard ? `<div class="pron-heard"><strong>Heard:</strong> "${escapeHtml(grade.heard)}"</div>` : ''}
  `;
}
