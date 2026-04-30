// Tap-word-for-translation. Wraps each Spanish word in a clickable span;
// on tap, fetches contextual translation from the Worker and shows a popover
// with "Add to vocab" button.

import { getIdToken } from './auth.js';
import { saveWord } from './vocab.js';
import { speak } from './voice.js';

const WORKER_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8787'
  : 'https://maestra-lupita-worker.christiankholden.workers.dev';

// Spanish word: letters incl. accented + ñ + ü, optional internal apostrophe (rare)
const WORD_RE = /^[a-záéíóúñüÁÉÍÓÚÑÜA-Z]+$/;

/**
 * Walk text nodes inside `root` and wrap each Spanish word in a tappable span.
 * Idempotent — won't double-wrap if called twice.
 */
export function makeWordsTappable(root) {
  if (!root || root.dataset.wordTapWired === '1') return;
  root.dataset.wordTapWired = '1';

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip if the parent is already a word-tap span
      if (node.parentNode?.classList?.contains('word-tap')) return NodeFilter.FILTER_REJECT;
      return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const tn of textNodes) {
    const tokens = tn.textContent.split(/(\s+|[.,;:¿?¡!()«»"—–\-\/…]+)/);
    if (tokens.length < 2) continue; // nothing to wrap

    const frag = document.createDocumentFragment();
    for (const tok of tokens) {
      if (!tok) continue;
      if (WORD_RE.test(tok)) {
        const span = document.createElement('span');
        span.className = 'word-tap';
        span.textContent = tok;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(tok));
      }
    }
    tn.parentNode.replaceChild(frag, tn);
  }

  // Event delegation
  root.addEventListener('click', (e) => {
    const span = e.target.closest('.word-tap');
    if (!span) return;
    e.stopPropagation();
    showWordPopover(span);
  });
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

let activePopover = null;

function dismissPopover() {
  activePopover?.remove();
  activePopover = null;
  document.removeEventListener('click', dismissOnOutsideClick);
}
function dismissOnOutsideClick(e) {
  if (activePopover && !activePopover.contains(e.target)) dismissPopover();
}

async function showWordPopover(span) {
  dismissPopover();

  const word = span.textContent.trim();
  // Find the sentence the word lives in (simple heuristic — walk the parent .message__text)
  const messageEl = span.closest('.message__text');
  const sentence = messageEl ? messageEl.textContent.trim() : word;

  const rect = span.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'word-popover';
  pop.innerHTML = `
    <div class="word-popover__head">
      <span class="word-popover__es">${escapeHtml(word)}</span>
      <button class="word-popover__pronounce" title="Pronounce" aria-label="Pronounce">🔊</button>
    </div>
    <div class="word-popover__body">
      <div class="word-popover__loading">Translating…</div>
    </div>
  `;
  document.body.appendChild(pop);
  activePopover = pop;
  positionPopover(pop, rect);
  setTimeout(() => document.addEventListener('click', dismissOnOutsideClick), 50);

  pop.querySelector('.word-popover__pronounce').addEventListener('click', (e) => {
    e.stopPropagation();
    speak(word, { force: true });
  });

  // Fetch translation
  try {
    const token = await getIdToken();
    const resp = await fetch(`${WORKER_BASE}/translate-word`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ word, sentence }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderPopoverBody(pop, word, data);
  } catch (err) {
    pop.querySelector('.word-popover__body').innerHTML = `<div class="word-popover__error">Couldn't translate: ${escapeHtml(err.message)}</div>`;
  }
}

function renderPopoverBody(pop, word, data) {
  const body = pop.querySelector('.word-popover__body');
  body.innerHTML = `
    <div class="word-popover__translation">${escapeHtml(data.translation || '—')}</div>
    <div class="word-popover__meta">
      <span class="word-popover__pos">${escapeHtml(data.partOfSpeech || '')}</span>
      ${data.register && data.register !== 'neutral' ? `<span class="word-popover__reg">${escapeHtml(data.register)}</span>` : ''}
    </div>
    ${data.contextualMeaning ? `<div class="word-popover__context">${escapeHtml(data.contextualMeaning)}</div>` : ''}
    ${data.example ? `<div class="word-popover__example">${escapeHtml(data.example)}</div>` : ''}
    <button class="word-popover__add" id="word-popover-add">+ Add to vocab</button>
  `;
  body.querySelector('#word-popover-add').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '⏳ Saving…';
    try {
      await saveWord({
        spanish: word,
        english: data.translation || '',
        partOfSpeech: data.partOfSpeech || 'word',
        category: 'general',
        example: data.example || '',
      });
      btn.textContent = '✓ Saved';
      btn.classList.add('word-popover__add--saved');
      setTimeout(dismissPopover, 800);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Failed: ${err.message}`;
    }
  });
}

function positionPopover(pop, anchorRect) {
  // Position below the word; flip to above if too close to the bottom
  const popHeight = 200; // estimate
  const popWidth = Math.min(280, window.innerWidth - 24);
  pop.style.width = `${popWidth}px`;

  const spaceBelow = window.innerHeight - anchorRect.bottom;
  const placeAbove = spaceBelow < popHeight && anchorRect.top > popHeight;

  let left = anchorRect.left + (anchorRect.width / 2) - (popWidth / 2);
  left = Math.max(12, Math.min(left, window.innerWidth - popWidth - 12));
  pop.style.left = `${left}px`;

  if (placeAbove) {
    pop.style.bottom = `${window.innerHeight - anchorRect.top + 6}px`;
    pop.style.top = 'auto';
  } else {
    pop.style.top = `${anchorRect.bottom + 6}px`;
    pop.style.bottom = 'auto';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
