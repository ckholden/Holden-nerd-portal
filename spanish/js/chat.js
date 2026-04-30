import { streamChat } from './api.js';

const MAX_TURNS = 20; // keep latest N user+assistant pairs (40 messages)

export class ChatSession {
  constructor({ correctionMode = 'gentle', mode = 'chat', scenario = null, topic = null } = {}) {
    this.correctionMode = correctionMode;
    this.mode = mode;
    this.scenario = scenario;
    this.topic = topic;
    this.messages = [];       // [{role:'user'|'assistant', content:'...'}]
    this.sessionSummary = null; // set when history is truncated
    this._onToken = null;
    this._onMessage = null;
    this._onError = null;
    this._streaming = false;
  }

  onToken(fn) { this._onToken = fn; return this; }
  onMessage(fn) { this._onMessage = fn; return this; }
  onError(fn) { this._onError = fn; return this; }

  async send(userText) {
    if (this._streaming) return;
    this._streaming = true;

    this.messages.push({ role: 'user', content: userText });

    // Enforce 20-turn cap (simple truncation for Phase 1;
    // Phase 5 will add Haiku summarization of the dropped turns)
    if (this.messages.length > MAX_TURNS * 2) {
      this.messages = this.messages.slice(-MAX_TURNS * 2);
    }

    let fullResponse = '';

    try {
      const stream = streamChat({
        messages: this.messages,
        mode: this.mode,
        correctionMode: this.correctionMode,
        scenario: this.scenario,
        topic: this.topic,
        sessionSummary: this.sessionSummary,
      });

      for await (const token of stream) {
        fullResponse += token;
        this._onToken?.(token);
      }

      this.messages.push({ role: 'assistant', content: fullResponse });
      this._onMessage?.(fullResponse);
    } catch (err) {
      this._onError?.(err);
    } finally {
      this._streaming = false;
    }

    // Persist to localStorage every send (iOS PWA state recovery)
    this._persist();

    return fullResponse;
  }

  clear() {
    this.messages = [];
    this.sessionSummary = null;
    this._persist();
  }

  _persist() {
    try {
      localStorage.setItem('chat_session', JSON.stringify({
        messages: this.messages,
        sessionSummary: this.sessionSummary,
        mode: this.mode,
        correctionMode: this.correctionMode,
      }));
    } catch {
      // storage full or unavailable — not critical
    }
  }

  restore() {
    try {
      const raw = localStorage.getItem('chat_session');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      this.messages = saved.messages ?? [];
      this.sessionSummary = saved.sessionSummary ?? null;
      return this.messages.length > 0;
    } catch {
      return false;
    }
  }

  getTranscript() {
    return this.messages;
  }
}

// ---------------------------------------------------------------------------
// DOM rendering helpers
// ---------------------------------------------------------------------------

export function renderMessage({ role, content, streaming = false }) {
  const el = document.createElement('div');
  el.className = `message message--${role}${streaming ? ' message--streaming' : ''}`;
  el.dataset.role = role;

  if (role === 'assistant') {
    const { mainText, tipText, correctionText } = parseAssistantContent(content);

    const textEl = document.createElement('div');
    textEl.className = 'message__text';
    textEl.textContent = mainText;

    el.appendChild(textEl);

    // English translation toggle (populated lazily in Phase 2+; placeholder for now)
    const enToggle = document.createElement('button');
    enToggle.className = 'message__toggle';
    enToggle.textContent = 'EN';
    enToggle.setAttribute('aria-label', 'Show English translation');
    enToggle.onclick = () => enToggle.classList.toggle('active');
    el.appendChild(enToggle);

    if (tipText || correctionText) {
      const corrEl = document.createElement('div');
      corrEl.className = 'message__corrections hidden';
      corrEl.textContent = tipText || correctionText;
      el.appendChild(corrEl);

      const corrToggle = document.createElement('button');
      corrToggle.className = 'message__toggle';
      corrToggle.textContent = '✏️';
      corrToggle.setAttribute('aria-label', 'Show corrections');
      corrToggle.onclick = () => corrEl.classList.toggle('hidden');
      el.appendChild(corrToggle);
    }
  } else {
    const textEl = document.createElement('div');
    textEl.className = 'message__text';
    textEl.textContent = content;
    el.appendChild(textEl);
  }

  return el;
}

export function appendStreamingMessage(container, scrollEl) {
  const el = renderMessage({ role: 'assistant', content: '', streaming: true });
  const textEl = el.querySelector('.message__text');
  container.appendChild(el);
  scrollEl.scrollTop = scrollEl.scrollHeight;

  return {
    appendToken(token) {
      textEl.textContent += token;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    },
    finalize(fullContent) {
      el.classList.remove('message--streaming');
      // Re-parse to split out tip/correction sections
      const { mainText, tipText, correctionText } = parseAssistantContent(fullContent);
      textEl.textContent = mainText;

      if (tipText || correctionText) {
        const corrEl = el.querySelector('.message__corrections') ?? (() => {
          const d = document.createElement('div');
          d.className = 'message__corrections hidden';
          el.appendChild(d);
          const btn = document.createElement('button');
          btn.className = 'message__toggle';
          btn.textContent = '✏️';
          btn.onclick = () => d.classList.toggle('hidden');
          el.appendChild(btn);
          return d;
        })();
        corrEl.textContent = tipText || correctionText;
      }
    },
  };
}

// Split "main reply \n\n💡 Tip: ..." or "✏️ Correcciones: ..." from assistant text
function parseAssistantContent(text) {
  const tipMatch = text.match(/\n\n💡\s*Tip[:\s]+([\s\S]+?)(?:\n\n📚|$)/i);
  const corrMatch = text.match(/\n\n✏️\s*Correcciones[:\s]+([\s\S]+?)(?:\n\n📚|$)/i);
  const strictMatch = text.match(/\n\n📚\s*Análisis[:\s]+([\s\S]+)$/i);

  const firstSplit = text.search(/\n\n(💡|✏️|📚)/);
  const mainText = firstSplit > -1 ? text.slice(0, firstSplit).trim() : text.trim();
  const tipText = (tipMatch?.[1] ?? corrMatch?.[1] ?? strictMatch?.[1] ?? '').trim();

  return { mainText, tipText, correctionText: '' };
}
