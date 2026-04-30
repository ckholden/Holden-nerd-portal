// Today's Focus card + streak tracker.
// Shows: streak count, cards due, today's recommended focus, quick-start chips.

import { db } from './firebase-config.js';
import { ref, get, set } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { getCurrentUser } from './auth.js';
import { loadVocabBank, getDueCards } from './vocab.js';

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
  // Load all in parallel
  const [streak, focus, vocabBank] = await Promise.all([
    loadStreak(),
    loadLearnerFocus(),
    loadVocabBank().catch(() => []),
  ]);
  const dueCount = getDueCards(vocabBank).length;
  const recFocus = focus?.nextRecommendedFocus?.[0] || null;
  const shaky = focus?.grammarWeaknesses?.[0] || null;

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
      ${dueCount > 0 ? `<button class="focus-card__cta" data-action="review-cards">📚 ${dueCount} card${dueCount === 1 ? '' : 's'} due</button>` : ''}
    </div>

    ${recFocus || shaky ? `
      <div class="focus-card__focus">
        <span class="focus-card__focus-label">🎯 Today's focus</span>
        <div class="focus-card__focus-text">${escapeHtml(recFocus || `Practice ${humanize(shaky)}`)}</div>
      </div>
    ` : ''}

    <div class="focus-card__chips">
      <button class="focus-chip" data-action="quickstart" data-prompt="¿Cómo estuvo tu día?">¿Cómo estuvo tu día?</button>
      <button class="focus-chip" data-action="quickstart" data-prompt="Help me with a grammar concept I'm shaky on.">Grammar tune-up</button>
      <button class="focus-chip" data-action="quickstart" data-prompt="Practice ordering food in Spanish with me.">Order food</button>
      <button class="focus-chip" data-action="quickstart" data-prompt="Practice what to ask a Spanish-speaking patient at intake.">Patient intake practice</button>
    </div>
  `;

  card.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => onChip?.(btn.dataset));
  });

  container.appendChild(card);
}

function humanize(id) {
  return String(id).replace(/_/g, ' ');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
