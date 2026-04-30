// Scenario picker + session launcher.
// On selection: switch the chat session into scenario mode (Worker assembles the
// SCENARIO_PROMPT_TEMPLATE with the scenario data injected as the tutor's role).

let scenarios = null;

export async function loadScenarios() {
  if (scenarios) return scenarios;
  const resp = await fetch('./data/scenarios.json');
  if (!resp.ok) throw new Error('Failed to load scenarios');
  scenarios = await resp.json();
  return scenarios;
}

const LEVEL_LABELS = {
  beginner:     { label: 'Beginner',     color: '#5cb85c' },
  intermediate: { label: 'Intermediate', color: '#f0ad4e' },
  advanced:     { label: 'Advanced',     color: '#e94560' },
};

/** Build the scenario picker grid. Calls onSelect(scenario) when a card is clicked. */
export function renderScenarioPicker(container, { onSelect } = {}) {
  if (!scenarios) {
    container.innerHTML = '<p class="coming-soon-msg">Loading scenarios…</p>';
    return;
  }

  container.innerHTML = `
    <div class="scenarios-header">
      <h2>Real-world scenarios</h2>
      <p>Pick a situation. Lupita plays the role. Your goal is to navigate the conversation in Spanish.</p>
    </div>
    <div class="scenarios-grid"></div>
  `;

  const grid = container.querySelector('.scenarios-grid');

  for (const s of scenarios) {
    const card = document.createElement('button');
    card.className = `scenario-card scenario-card--${s.level}`;
    card.innerHTML = `
      <div class="scenario-card__top">
        <span class="scenario-card__emoji">${s.emoji}</span>
        <span class="scenario-card__level" style="background:${LEVEL_LABELS[s.level]?.color || '#888'}">${LEVEL_LABELS[s.level]?.label || s.level}</span>
      </div>
      <div class="scenario-card__title">${s.title}</div>
      <div class="scenario-card__sub">${s.subtitle}</div>
      <div class="scenario-card__meta">
        <span>⏱ ~${s.estimatedMinutes} min</span>
      </div>
    `;
    card.addEventListener('click', () => onSelect?.(s));
    grid.appendChild(card);
  }
}

/** Render a "now playing" banner above the chat with scenario context + exit button. */
export function renderScenarioBanner(scenario, { onExit } = {}) {
  const banner = document.createElement('div');
  banner.className = 'scenario-banner';
  banner.innerHTML = `
    <div class="scenario-banner__main">
      <span class="scenario-banner__emoji">${scenario.emoji}</span>
      <div>
        <div class="scenario-banner__title">${scenario.title}</div>
        <div class="scenario-banner__goal"><strong>Goal:</strong> ${scenario.userGoal}</div>
      </div>
    </div>
    <button class="scenario-banner__exit" aria-label="Exit scenario" title="Exit scenario">✕</button>
  `;
  banner.querySelector('.scenario-banner__exit').addEventListener('click', () => onExit?.());
  return banner;
}

/** Build the opening user message that primes Lupita to start in character. */
export function scenarioOpeningPrompt(scenario) {
  // We send a synthetic kickoff so Lupita opens IN CHARACTER, in the scene,
  // without Christian having to type "ok start"
  return `[SCENARIO START — please begin in character as described in your role. The scene: ${scenario.setting}. Greet me naturally and start the interaction. Speak only Spanish.]`;
}
