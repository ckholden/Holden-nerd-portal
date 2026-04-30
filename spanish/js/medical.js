// Medical Spanish module — patient interaction simulations + cultural notes.
// Mirrors scenarios.js but uses MEDICAL_PROMPT_TEMPLATE on the Worker.

let topics = null;

export async function loadMedicalTopics() {
  if (topics) return topics;
  const resp = await fetch('./data/medical-topics.json');
  if (!resp.ok) throw new Error('Failed to load medical topics');
  topics = await resp.json();
  return topics;
}

const CATEGORY_META = {
  assessment:  { label: 'Assessment',  color: '#5cb85c' },
  teaching:    { label: 'Teaching',    color: '#5bc0de' },
  emergency:   { label: 'Emergency',   color: '#d9534f' },
  culture:     { label: 'Culture',     color: '#9b59b6' },
  vocabulary:  { label: 'Vocab',       color: '#f0ad4e' },
  advanced:    { label: 'Advanced',    color: '#e94560' },
};

export function renderMedicalPicker(container, { onSelect } = {}) {
  if (!topics) {
    container.innerHTML = '<p class="coming-soon-msg">Loading medical topics…</p>';
    return;
  }

  container.innerHTML = `
    <div class="scenarios-header">
      <h2>Medical Spanish for nursing practice</h2>
      <p>Realistic patient interactions in the Spanish a Mexican-American patient in Oregon would actually use. Cultural notes included for each topic.</p>
    </div>
    <div class="scenarios-grid"></div>
  `;

  const grid = container.querySelector('.scenarios-grid');

  for (const t of topics) {
    const card = document.createElement('button');
    const cat = CATEGORY_META[t.category] || { label: t.category, color: '#888' };
    card.className = 'scenario-card scenario-card--medical';
    card.innerHTML = `
      <div class="scenario-card__top">
        <span class="scenario-card__emoji">${t.emoji}</span>
        <span class="scenario-card__level" style="background:${cat.color}">${cat.label}</span>
      </div>
      <div class="scenario-card__title">${t.title}</div>
      <div class="scenario-card__sub">${t.subtitle}</div>
      <div class="scenario-card__meta">
        <span>⏱ ${t.duration}</span>
        <span>📚 ${t.level}</span>
      </div>
    `;
    card.addEventListener('click', () => onSelect?.(t));
    grid.appendChild(card);
  }
}

/** Banner shown above the chat when a medical topic session is active. */
export function renderMedicalBanner(topic, { onExit } = {}) {
  const banner = document.createElement('div');
  banner.className = 'scenario-banner medical-banner';
  banner.innerHTML = `
    <div class="scenario-banner__main">
      <span class="scenario-banner__emoji">${topic.emoji}</span>
      <div>
        <div class="scenario-banner__title">${topic.title}</div>
        <div class="scenario-banner__goal">
          <strong>Cultural note:</strong> <span class="medical-banner__note">${topic.culturalNote}</span>
        </div>
      </div>
    </div>
    <button class="scenario-banner__exit" aria-label="Exit topic" title="Exit topic">✕</button>
  `;
  banner.querySelector('.scenario-banner__exit').addEventListener('click', () => onExit?.());
  return banner;
}

/** Synthetic kickoff so Lupita opens in character per the topic's tutorRole. */
export function medicalOpeningPrompt(topic) {
  return `[MEDICAL TOPIC START — ${topic.title}. Begin with a brief 2-3 sentence English intro covering the goal and the key cultural note (${topic.culturalNote}), then transition into Spanish for the simulated interaction. Take on the role described.]`;
}
