import { getIdToken } from './auth.js';

const WORKER_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8787'
  : 'https://maestra-lupita-worker.christiankholden.workers.dev';

async function authedHeaders(extra = {}) {
  const token = await getIdToken();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...extra,
  };
}

/**
 * Stream a chat message to Maestra Lupita.
 * Yields string tokens as they arrive.
 *
 * @param {object} opts
 * @param {Array} opts.messages  Full conversation history (up to 20 turns)
 * @param {string} opts.mode  'chat' | 'scenario' | 'medical' | 'placement'
 * @param {string} opts.correctionMode  'gentle' | 'active' | 'strict'
 * @param {object|null} opts.scenario
 * @param {object|null} opts.topic
 * @param {string|null} opts.sessionSummary  Summary of truncated prior turns
 * @yields {string} token chunks
 */
export async function* streamChat(opts = {}) {
  const { messages, mode = 'chat', correctionMode = 'gentle', scenario = null, topic = null, sessionSummary = null } = opts;

  const resp = await fetch(`${WORKER_BASE}/chat`, {
    method: 'POST',
    headers: await authedHeaders(),
    body: JSON.stringify({ messages, mode, correctionMode, scenario, topic, sessionSummary }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || `Chat failed: ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const evt = JSON.parse(raw);
        if (evt.error) throw new Error(evt.error);
        if (evt.token) yield evt.token;
      } catch (e) {
        if (e.message && !e.message.startsWith('Unexpected')) throw e;
        // else: malformed SSE line, ignore
      }
    }
  }
}

export async function checkHealth() {
  const resp = await fetch(`${WORKER_BASE}/health`);
  return resp.ok;
}

/** Send a transcript to /analyze for post-session learner-model update. */
export async function analyzeSession(messages) {
  if (!messages || messages.length < 2) return null;
  const resp = await fetch(`${WORKER_BASE}/analyze`, {
    method: 'POST',
    headers: await authedHeaders(),
    body: JSON.stringify({ messages }),
  });
  if (!resp.ok) throw new Error(`Analyze failed: ${resp.status}`);
  return resp.json();
}

/** Compress N turns into a 2-3 sentence summary (used for history truncation). */
export async function summarizeTurns(turns) {
  if (!turns?.length) return '';
  const resp = await fetch(`${WORKER_BASE}/summarize`, {
    method: 'POST',
    headers: await authedHeaders(),
    body: JSON.stringify({ turns }),
  });
  if (!resp.ok) throw new Error(`Summarize failed: ${resp.status}`);
  const data = await resp.json();
  return data.summary || '';
}
