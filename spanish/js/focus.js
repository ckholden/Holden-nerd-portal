// Today's Focus card + streak tracker.
// Shows: streak count, cards due, today's recommended focus, quick-start chips.

import { db } from './firebase-config.js';
import { ref, get, set } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { getCurrentUser } from './auth.js';
import { loadVocabBank, getDueCards } from './vocab.js';
import { loadCurriculum, loadProgress, getCurrentLesson, getProgressStats } from './curriculum.js';

function todayStamp() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Increment streak if first activity of the day; reset if gap >1 day. */
export async function recordActivity() {
  const user = getCurrentUser();
  if (!user) return null;
  const streakRef = ref(db, `users/${user.uid}/streak`);
  let streak;
  try {
    const snap = await get(streakRef);
    streak = snap.exists() ? snap.val() : { current: 0, longest: 0, lastActiveDate: null };
  } catch {
    streak = { current: 0, longest: 0, lastActiveDate: null };
  }

  const today = todayStamp();
  if (streak.lastActiveDate === today) return streak; // already counted

  // Calculate gap
  if (streak.lastActiveDate) {
    const last = new Date(streak.lastActiveDate);
    const now = new Date(today);
    const diffDays = Math.round((now - last) / 86400000);
    if (diffDays === 1) {
      streak.current = (streak.current || 0) + 1;
    } else {
      streak.current = 1; // missed a day → reset
    }
  } else {
    streak.current = 1;
  }
  streak.longest = Math.max(streak.longest || 0, streak.current);
  streak.lastActiveDate = today;

  try { await set(streakRef, streak); } catch {}
  return streak;
}

export async function loadStreak() {
  const user = getCurrentUser();
  if (!user) return null;
  try {
    const snap = await get(ref(db, `users/${user.uid}/streak`));
    return snap.exists() ? snap.val() : { current: 0, longest: 0 };
  } catch {
    return { current: 0, longest: 0 };
  }
}

export async function loadLearnerFocus() {
  const user = getCurrentUser();
  if (!user) return null;
  try {
    const snap = await get(ref(db, `users/${user.uid}/learnerModel`));
    return snap.exists() ? snap.val() : null;
  } catch {
    return null;
  }
}

/** Render the today's-focus card at the top of an empty chat. */
export async function renderFocusCard(container, { onChip } = {}) {
  const [streak, focus, vocabBank, curr, progress] = await Promise.all([
    loadStreak(),
    loadLearnerFocus(),
    loadVocabBank().catch(() => []),
    loadCurriculum().catch(() => null),
    loadProgress(),
  ]);
  const dueCount = getDueCards(vocabBank).length;
  const todaysLesson = curr ? getCurrentLesson(curr, progress) : null;
  const stats = curr ? getProgressStats(curr, progress) : null;

  const card = document.createElement('div');
  card.className = 'focus-card';

  const streakEmoji = !streak?.current ? '✨' : streak.current >= 7 ? '🔥' : streak.current >= 3 ? '⭐' : '🌱';
  const streakLabel = !streak?.current ? "Start your streak today" : `${streak.current}-day streak${streak.current === streak.longest && streak.current > 1 ? ' · personal best!' : ''}`;

  card.innerHTML = `
    <div class="focus-card__top">
      <div class="focus-card__streak">
        <span class="focus-card__streak-emoji">${streakEmoji}</span>
        <span class="focus-card__streak-label">${streakLabel}</span>
      </div>
      ${dueCount > 0 ? `<button class="focus-card__cta-mini" data-action="review-cards">📚 ${dueCount} due</button>` : ''}
    </div>

    ${todaysLesson ? `
      <div class="focus-card__lesson">
        <div class="focus-card__lesson-meta">
          <span class="focus-card__lesson-num">Lesson ${stats.completed + 1} of ${stats.total}</span>
          <span class="focus-card__lesson-track focus-card__lesson-track--${todaysLesson.track}">${todaysLesson.track}</span>
        </div>
        <div class="focus-card__lesson-title">${escapeHtml(todaysLesson.title)}</div>
        <div class="focus-card__lesson-sub">${escapeHtml(todaysLesson.subtitle || '')}</div>
        <div class="focus-card__lesson-buttons">
          <button class="btn btn--primary focus-card__lesson-go" data-action="start-lesson" data-mode="quick">▶ Quick (${Math.max(5, Math.round(todaysLesson.estimatedMinutes * 0.6))} min)</button>
          <button class="btn btn--ghost focus-card__lesson-go" data-action="start-lesson" data-mode="deep">Deep (${todaysLesson.estimatedMinutes + 10} min)</button>
        </div>
        <div class="focus-card__lesson-progress" aria-label="Course progress">
          <div class="focus-card__lesson-progress-bar" style="width:${stats.percent}%"></div>
        </div>
      </div>
    ` : (curr ? `
      <div class="focus-card__lesson focus-card__lesson--done">
        <div class="focus-card__lesson-title">🎉 Course complete!</div>
        <div class="focus-card__lesson-sub">All ${stats.total} lessons done. Free chat below.</div>
      </div>
    ` : '')}

    <div class="focus-card__chips">
      <span class="focus-card__chips-label">Or jump into:</span>
      <button class="focus-chip" data-action="quickstart" data-prompt="¿Cómo estuvo tu día?">Free chat</button>
      <button class="focus-chip" data-action="goto-tab" data-tab="scenarios">Scenarios</button>
      <button class="focus-chip" data-action="goto-tab" data-tab="medical">Medical</button>
      <button class="focus-chip" data-action="goto-tab" data-tab="vocab">Vocab</button>
    </div>
  `;

  card.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => onChip?.(btn.dataset, todaysLesson));
  });

  container.appendChild(card);
}

function humanize(id) {
  return String(id).replace(/_/g, ' ');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
