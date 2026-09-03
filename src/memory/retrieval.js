'use strict';

// Deterministic keyword/entity retrieval. No embeddings, no vector DB —
// inspectable matching over bounded memory lists using signals from the
// current perception + goal.

const STOPWORDS = new Set([
  'the', 'and', 'with', 'from', 'that', 'this', 'have', 'has', 'are', 'was',
  'were', 'will', 'would', 'should', 'could', 'need', 'needs', 'more', 'very',
  'before', 'after', 'while', 'when', 'where', 'there', 'here', 'near',
  'nearby', 'current', 'safely', 'safely', 'just', 'also', 'into', 'onto',
]);

const RELATED = {
  creeper: ['creeper', 'explosion', 'explode', 'combat', 'retreat', 'tnt'],
  zombie: ['zombie', 'combat', 'undead', 'night', 'fight', 'retreat'],
  skeleton: ['skeleton', 'arrow', 'bow', 'combat', 'cover', 'shield'],
  spider: ['spider', 'combat', 'night'],
  diamond: ['diamond', 'pickaxe', 'mining', 'iron', 'ore', 'tool'],
  iron: ['iron', 'furnace', 'smelt', 'pickaxe', 'mining', 'ore'],
  coal: ['coal', 'torch', 'furnace', 'mining', 'fuel'],
  night: ['night', 'shelter', 'bed', 'hostile', 'torch', 'dark'],
  shelter: ['shelter', 'house', 'bed', 'night', 'base', 'home'],
  bed: ['bed', 'sleep', 'night', 'spawn', 'shelter'],
  hunger: ['food', 'hunger', 'eat', 'farm', 'bread'],
  food: ['food', 'hunger', 'eat', 'farm', 'bread'],
  lava: ['lava', 'fire', 'bucket', 'water', 'danger'],
  water: ['water', 'bucket', 'drown', 'swim'],
  mine: ['mine', 'shaft', 'ore', 'pickaxe', 'torch', 'cave'],
  combat: ['combat', 'fight', 'sword', 'retreat', 'armor'],
};

function tokensOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function signalTokens(signals = {}) {
  const tokens = new Set();
  const add = (text) => {
    for (const t of tokensOf(text)) tokens.add(t);
    // Expand related terms.
    for (const t of tokensOf(text)) {
      for (const rel of RELATED[t] || []) tokens.add(rel);
    }
  };
  if (signals.goal) add(signals.goal);
  for (const m of signals.mobTypes || []) add(m);
  for (const b of signals.blockTypes || []) {
    add(b);
    // diamond_ore -> diamond + ore
    for (const part of String(b).split('_')) {
      if (part.length >= 3) add(part);
    }
  }
  for (const f of signals.recentFailures || []) add(f);
  for (const e of signals.equipment || []) add(e);
  for (const l of signals.locationNames || []) add(l);
  if (signals.danger) add('combat retreat danger hostile night');
  if (signals.night) add('night shelter bed hostile');
  if (signals.hungry) add('food hunger eat');
  return tokens;
}

function scoreText(text, tokenSet) {
  const toks = tokensOf(text);
  if (toks.length === 0) return 0;
  let score = 0;
  for (const t of toks) {
    if (tokenSet.has(t)) score += 1;
  }
  return score;
}

function retrieveList(items, textOf, tokenSet, limit) {
  const scored = [];
  for (const item of items || []) {
    const s = scoreText(textOf(item), tokenSet);
    if (s > 0) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

function buildSignals({ goal, perception, recentFailures = [] } = {}) {
  const signals = {
    goal: typeof goal === 'string' ? goal : goal?.description || '',
    mobTypes: [],
    blockTypes: [],
    recentFailures,
    equipment: [],
    locationNames: [],
    danger: false,
    night: false,
    hungry: false,
  };
  try {
    const entities = perception?.nearbyEntitiesDetailed || perception?.nearbyEntities || [];
    for (const e of entities.slice(0, 20)) {
      const t = e?.type || e?.name;
      if (t) signals.mobTypes.push(String(t));
      if (e?.hostile) signals.danger = true;
    }
    for (const b of (perception?.interestingBlocks || []).slice(0, 30)) {
      if (b?.type) signals.blockTypes.push(String(b.type));
    }
    const self = perception?.self || {};
    const food = self.food ?? perception?.food;
    if (Number.isFinite(food) && food <= 12) signals.hungry = true;
    const tc = perception?.environment?.timeCategory;
    if (tc === 'night') signals.night = true;
    const eq = perception?.equipment || {};
    for (const v of Object.values(eq)) if (v) signals.equipment.push(String(v));
    for (const l of perception?.knownLocationsNearby || []) {
      if (l?.name) signals.locationNames.push(String(l.name));
    }
  } catch {
    // ignore
  }
  return signals;
}

function retrieveRelevant({ goal, perception, recentFailures = [], stores, limits = {} } = {}) {
  const signals = buildSignals({ goal, perception, recentFailures });
  const tokenSet = signalTokens(signals);
  const semLimit = limits.semantic ?? 6;
  const epiLimit = limits.episodic ?? 4;
  const proLimit = limits.procedural ?? 4;
  const worldLimit = limits.world ?? 6;

  const semantic = retrieveList(
    stores?.semantic || [],
    (m) => `${m.subject || ''} ${m.content || ''}`,
    tokenSet, semLimit
  );
  const episodic = retrieveList(
    stores?.episodic || [],
    (m) => `${m.summary || ''} ${m.lesson || ''}`,
    tokenSet, epiLimit
  );
  const procedural = retrieveList(
    stores?.procedural || [],
    (m) => `${m.skillId || ''} ${m.description || ''}`,
    tokenSet, proLimit
  );
  // World memories: keyword match + always include very close locations.
  let world = retrieveList(
    stores?.world || [],
    (m) => `${m.name || ''} ${JSON.stringify(m.metadata || {})}`,
    tokenSet, worldLimit
  );
  try {
    const nearby = new Set((perception?.knownLocationsNearby || []).slice(0, 4).map((l) => l.name));
    for (const w of stores?.world || []) {
      if (nearby.has(w.name) && !world.includes(w) && world.length < worldLimit) world.push(w);
    }
  } catch {
    // ignore
  }
  return { semantic, episodic, procedural, world, signals: { ...signals, tokens: [...tokenSet].slice(0, 40) } };
}

module.exports = { buildSignals, retrieveRelevant, tokensOf };
