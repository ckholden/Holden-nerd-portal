// Curriculum + lesson player.
// 30 sequential lessons toward clinical readiness + conversational confidence.

import { db } from './firebase-config.js';
import { ref, get, set } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { getCurrentUser } from './auth.js';

let curriculum = null;

export async function loadCurriculum() {
  if (curriculum) return curriculum;
  const resp = await fetch('./data/curriculum.json');
  if (!resp.ok) throw new Error('Failed to load curriculum');
  curriculum = await resp.json();
  return curriculum;
}

export async function loadProgress() {
  const user = getCurrentUser();
  if (!user) return {};
  try {
    const snap = await get(ref(db, `users/${user.uid}/progress/course1/lessons`));
    return snap.exists() ? snap.val() : {};
  } catch {
    return {};
  }
}

export function getCurrentLesson(curr, progressMap) {
  for (const lesson of curr.lessons) {
    if (!progressMap[lesson.id]) return lesson;
  }
  return null; // course completed!
}

export function getProgressStats(curr, progressMap) {
  const total = curr.lessons.length;
  const completed = Object.keys(progressMap).length;
  return { completed, total, percent: Math.round(100 * completed / total) };
}

export async function markLessonComplete(lessonId, score, mode) {
  const user = getCurrentUser();
  if (!user) return;
  await set(ref(db, `users/${user.uid}/progress/course1/lessons/${lessonId}`), {
    completedAt: Date.now(),
    score: Math.round(score || 0),
    mode: mode || 'quick',
  });
}

// ---------------------------------------------------------------------------
// Lesson player UI
// ---------------------------------------------------------------------------

const STEPS_QUICK = ['warmup', 'practice', 'mastery'];
const STEPS_DEEP = ['warmup', 'intro', 'practice', 'teachBack', 'mastery'];

const STEP_LABELS = {
  warmup:    'Warm-up',
  intro:     'Intro',
  practice:  'Practice',
  teachBack: 'Teach-back',
  mastery:   'Mastery check',
};

/**
 * Render the lesson player into a container. Calls onComplete(score) when done,
 * onExit() when user bails out, onSendMessage(text, opts) to push a message
 * into the chat (the host wires this to a ChatSession).
 */
export function renderLessonPlayer(container, { lesson, mode = 'quick', onComplete, onExit, onSendMessage }) {
  const steps = mode === 'deep' ? STEPS_DEEP : STEPS_QUICK;
  let stepIdx = 0;
  let bestMasteryScore = 0;

  function paint() {
    const stepKey = steps[stepIdx];
    container.innerHTML = `
      <div class="lesson-player">
        <header class="lesson-player__header">
          <button class="icon-btn" id="lesson-exit" aria-label="Exit lesson">←</button>
          <div class="lesson-player__title">
            <div class="lesson-player__lesson">${escapeHtml(lesson.title)}</div>
            <div class="lesson-player__sub">${mode === 'deep' ? 'Deep' : 'Quick'} · Step ${stepIdx + 1} of ${steps.length}</div>
          </div>
        </header>

        <div class="lesson-player__progress">
          ${steps.map((s, i) => `<span class="lesson-step ${i < stepIdx ? 'lesson-step--done' : ''} ${i === stepIdx ? 'lesson-step--active' : ''}" title="${STEP_LABELS[s]}"></span>`).join('')}
        </div>

        <div class="lesson-player__body" id="lesson-body"></div>
      </div>
    `;

    container.querySelector('#lesson-exit').addEventListener('click', () => onExit?.());
    renderStep(stepKey);
  }

  function renderStep(key) {
    const body = container.querySelector('#lesson-body');
    if (!body) return;
    if (key === 'warmup')    return renderWarmup(body, lesson, () => advance());
    if (key === 'intro')     return renderIntro(body, lesson, () => advance());
    if (key === 'practice')  return renderPractice(body, lesson, mode, onSendMessage, () => advance());
    if (key === 'teachBack') return renderTeachBack(body, lesson, onSendMessage, () => advance());
    if (key === 'mastery')   return renderMastery(body, lesson, (score) => {
      bestMasteryScore = Math.max(bestMasteryScore, score);
      finish();
    });
  }

  function advance() {
    stepIdx++;
    if (stepIdx >= steps.length) finish();
    else paint();
  }

  function finish() {
    container.innerHTML = `
      <div class="lesson-done">
        <div class="lesson-done__emoji">${bestMasteryScore >= 80 ? '🌟' : bestMasteryScore >= 60 ? '👍' : '✅'}</div>
        <h2>Lesson complete!</h2>
        <p>${lesson.title}</p>
        ${bestMasteryScore ? `<div class="lesson-done__score">Score: ${bestMasteryScore}/100</div>` : ''}
        <button class="btn btn--primary" id="lesson-done-back">Back to home</button>
      </div>
    `;
    container.querySelector('#lesson-done-back').addEventListener('click', () => onComplete?.(bestMasteryScore));
  }

  paint();
}

// ── Step renderers ─────────────────────────────────────────────────────────

function renderWarmup(body, lesson, next) {
  const cardCount = Math.min(3, lesson.vocab?.length || 0);
  const cards = (lesson.vocab || []).slice(0, cardCount);
  let i = 0;
  let revealed = false;

  function paintCard() {
    if (i >= cards.length) { next(); return; }
    const c = cards[i];
    body.innerHTML = `
      <div class="lesson-warmup">
        <div class="lesson-warmup__hint">Vocab preview · ${i + 1} of ${cards.length}</div>
        <div class="lesson-warmup__card">
          <div class="lesson-warmup__es">${escapeHtml(c.es)}</div>
          <div class="lesson-warmup__en ${revealed ? '' : 'hidden'}">${escapeHtml(c.en)}</div>
          ${revealed ? `<div class="lesson-warmup__reg">${c.register || ''}</div>` : ''}
        </div>
        <button class="btn btn--ghost" id="warmup-flip">${revealed ? 'Next →' : 'Show meaning'}</button>
      </div>
    `;
    body.querySelector('#warmup-flip').addEventListener('click', () => {
      if (!revealed) { revealed = true; paintCard(); }
      else { i++; revealed = false; paintCard(); }
    });
  }
  paintCard();
}

function renderIntro(body, lesson, next) {
  body.innerHTML = `
    <div class="lesson-intro">
      <div class="lesson-intro__label">📚 Today's lesson</div>
      <h3 class="lesson-intro__h">${escapeHtml(lesson.title)}</h3>
      <p class="lesson-intro__sub">${escapeHtml(lesson.subtitle || '')}</p>
      <div class="lesson-intro__objectives">
        <div class="lesson-intro__objectives-h">You'll be able to:</div>
        <ul>${(lesson.objectives || []).map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>
      </div>
      <p class="lesson-intro__warmup">${escapeHtml(lesson.warmup || '')}</p>
      <button class="btn btn--primary" id="intro-next">Start practice →</button>
    </div>
  `;
  body.querySelector('#intro-next').addEventListener('click', () => next());
}

function renderPractice(body, lesson, mode, onSendMessage, next) {
  body.innerHTML = `
    <div class="lesson-practice">
      <div class="lesson-practice__label">🎭 Practice</div>
      <p class="lesson-practice__prompt">${escapeHtml(lesson.practice || 'Practice with Lupita.')}</p>
      <button class="btn btn--primary" id="practice-start">Start practice with Lupita</button>
      <div class="lesson-practice__hint">This will open the chat. Practice for ${mode === 'deep' ? '5–8 turns' : '2–3 turns'}, then come back.</div>
      <button class="btn btn--ghost" id="practice-done">Done practicing — continue →</button>
    </div>
  `;
  body.querySelector('#practice-start').addEventListener('click', () => {
    onSendMessage?.(lesson.practice, { mode: 'lesson', lesson, openChat: true });
  });
  body.querySelector('#practice-done').addEventListener('click', () => next());
}

function renderTeachBack(body, lesson, onSendMessage, next) {
  body.innerHTML = `
    <div class="lesson-teachback">
      <div class="lesson-teachback__label">🪞 Teach-back</div>
      <p class="lesson-teachback__prompt">${escapeHtml(lesson.teachBack || 'Now you teach Lupita.')}</p>
      <p class="lesson-teachback__hint">This is the highest-leverage step. Producing it (instead of recognizing it) is what makes vocabulary stick.</p>
      <button class="btn btn--primary" id="tb-start">Start teach-back with Lupita</button>
      <button class="btn btn--ghost" id="tb-done">Done — continue →</button>
    </div>
  `;
  body.querySelector('#tb-start').addEventListener('click', () => {
    onSendMessage?.(lesson.teachBack, { mode: 'lesson', lesson, openChat: true });
  });
  body.querySelector('#tb-done').addEventListener('click', () => next());
}

function renderMastery(body, lesson, complete) {
  const m = lesson.masteryCheck;
  if (!m) { complete(70); return; }

  body.innerHTML = `
    <div class="lesson-mastery">
      <div class="lesson-mastery__label">✓ Mastery check</div>
      <p class="lesson-mastery__instr">Say this phrase aloud. Your score will determine the lesson grade.</p>
      <div class="lesson-mastery__target">${escapeHtml(m.target)}</div>
      <button class="btn btn--primary" id="mastery-record">🎤 Record</button>
      <div id="mastery-result" class="lesson-mastery__result hidden"></div>
      <button class="btn btn--ghost hidden" id="mastery-skip">Skip — finish lesson</button>
    </div>
  `;

  const recBtn = body.querySelector('#mastery-record');
  const result = body.querySelector('#mastery-result');
  const skipBtn = body.querySelector('#mastery-skip');
  let recState = 'idle'; // idle | recording | scoring
  let attemptScore = 0;

  recBtn.addEventListener('click', async () => {
    if (recState === 'idle') {
      try {
        const { unlockAudio, VoiceRecorder } = await import('./voice.js');
        await unlockAudio();
        const rec = new VoiceRecorder();
        await rec.start();
        recState = 'recording';
        recBtn.textContent = '⏹️ Stop & score';
        recBtn._rec = rec;
      } catch (err) {
        result.classList.remove('hidden');
        result.innerHTML = `<span class="pron-feedback" style="color:#d9534f">Mic error: ${err.message}</span>`;
      }
    } else if (recState === 'recording') {
      const rec = recBtn._rec;
      const blob = await rec.stopAndGetBlob();
      rec.reset();
      recState = 'scoring';
      recBtn.textContent = '⏳ Scoring…';
      recBtn.disabled = true;

      try {
        const { getIdToken } = await import('./auth.js');
        const WORKER_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
          ? 'http://localhost:8787'
          : 'https://maestra-lupita-worker.christiankholden.workers.dev';
        const fd = new FormData();
        fd.append('audio', blob, 'mastery.webm');
        fd.append('target', m.target);
        const token = await getIdToken();
        const resp = await fetch(`${WORKER_BASE}/grade-pronunciation`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: fd,
        });
        const grade = await resp.json();
        attemptScore = grade.score ?? 0;

        const color = attemptScore >= (m.minScore || 70) ? '#5cb85c' : '#f0ad4e';
        const emoji = attemptScore >= 85 ? '🌟' : attemptScore >= (m.minScore || 70) ? '👍' : '🔁';
        result.classList.remove('hidden');
        result.innerHTML = `
          <div class="pron-score" style="color:${color}">${emoji} ${attemptScore}/100</div>
          <div class="pron-feedback">${escapeHtml(grade.feedback || '')}</div>
          ${grade.heard ? `<div class="pron-heard"><strong>Heard:</strong> "${escapeHtml(grade.heard)}"</div>` : ''}
        `;

        if (attemptScore >= (m.minScore || 70)) {
          // Pass — auto-advance
          setTimeout(() => complete(attemptScore), 1500);
        } else {
          // Below threshold — let them retry
          recBtn.textContent = '🎤 Try again';
          recBtn.disabled = false;
          recState = 'idle';
          skipBtn.classList.remove('hidden');
          skipBtn.onclick = () => complete(attemptScore);
        }
      } catch (err) {
        result.classList.remove('hidden');
        result.innerHTML = `<span class="pron-feedback" style="color:#d9534f">Score failed: ${err.message}</span>`;
        recBtn.textContent = '🎤 Try again';
        recBtn.disabled = false;
        recState = 'idle';
        skipBtn.classList.remove('hidden');
        skipBtn.onclick = () => complete(attemptScore || 50);
      }
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
