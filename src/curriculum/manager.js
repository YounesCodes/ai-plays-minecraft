'use strict';

// Curriculum session manager: WHAT milestone is active, deterministic
// transitions, progression history. The LLM never advances milestones;
// completion comes from trusted evaluator predicates over inventory,
// nearby blocks, and observed successful outcomes.
//
// Emergency interplay: the manager never overwrites an emergency goal —
// the loop skips curriculum sync while one is active, and re-syncs after
// resume (a stale resumed description is corrected to the active
// milestone, never blindly kept).

const { MILESTONES } = require('./milestones');
const { isComplete } = require('./evaluator');
const { recipeHint, craftTargetFor } = require('./recipes');

function hasItem(inventory, name, n = 1) {
  try {
    return Number((inventory || {})[name]) >= n;
  } catch {
    return false;
  }
}

// Downstream artifacts imply their upstream material steps for resumed
// runs (found/crafted pickaxe means wood was necessarily obtained and
// shaped, even if no logs remain). Conservative: only within this
// stone-age chain, never across unrelated milestones.
function inferredDone(state) {
  const done = new Set();
  const inv = (state && state.inventory) || {};
  let planks = 0;
  try {
    for (const [name, count] of Object.entries(inv)) {
      if (typeof name === 'string' && name.endsWith('_planks') && Number.isFinite(Number(count))) planks += Number(count);
    }
  } catch {
    // ignore
  }
  const hasPick = hasItem(inv, 'wooden_pickaxe') || hasItem(inv, 'stone_pickaxe');
  if (planks >= 1 || hasItem(inv, 'crafting_table') || hasPick) done.add('obtain_logs');
  if (hasItem(inv, 'crafting_table') || hasPick) done.add('make_planks');
  if (hasPick) {
    done.add('craft_crafting_table');
    done.add('establish_crafting_table');
  }
  if (hasItem(inv, 'stone_pickaxe')) {
    done.add('obtain_logs');
    done.add('make_planks');
    done.add('craft_crafting_table');
    done.add('establish_crafting_table');
    done.add('craft_wooden_pickaxe');
    done.add('obtain_cobblestone');
  }
  return done;
}

function createCurriculumManager({ milestones = MILESTONES } = {}) {
  const history = new Set(); // ids ever completed this session (survives consumption)
  let started = false;
  let lastActiveId = null;
  let firstTick = true;

  function evaluateAll(state) {
    const done = new Set(history);
    for (const id of inferredDone(state)) done.add(id);
    for (const m of milestones) {
      if (!done.has(m.id) && isComplete(m.id, state)) done.add(m.id);
    }
    return done;
  }

  function eligible(m, done) {
    return (m.prerequisites || []).every((p) => done.has(p));
  }

  function tick(state = {}) {
    const done = evaluateAll(state);
    const completed = milestones.filter((m) => done.has(m.id)).map((m) => m.id);
    // Newly satisfied since last tick.
    const newly = [];
    const skipped = [];
    for (const id of done) {
      if (!history.has(id)) {
        newly.push(id);
        if (firstTick) skipped.push(id);
      }
    }
    for (const id of done) history.add(id);
    firstTick = false;
    // Active = first eligible incomplete milestone in curriculum order.
    // Craft milestones carry their trusted recipe requirements so the
    // planner knows WHAT the step needs (materials + table or not).
    let active = null;
    for (const m of milestones) {
      if (done.has(m.id)) continue;
      if (!eligible(m, done)) continue;
      active = {
        id: m.id,
        description: m.description,
        reason: activeReason(m, done),
      };
      try {
        const target = craftTargetFor(m.id);
        if (target) {
          const hint = recipeHint(target, state.inventory, state.mcVersion);
          if (hint) active.recipe = hint;
        }
      } catch {
        // recipe hints are advisory; milestones work without them
      }
      break;
    }
    const activeChanged = (active ? active.id : null) !== lastActiveId;
    lastActiveId = active ? active.id : null;
    if (!started) started = true;
    const nextCandidates = milestones
      .filter((m) => !done.has(m.id) && eligible(m, done) && (!active || m.id !== active.id))
      .map((m) => m.id);
    return {
      activeMilestone: active,
      completedMilestones: completed,
      nextCandidates,
      newlyCompleted: newly.filter((id) => !skipped.includes(id)),
      newlySkipped: skipped,
      activeChanged,
      complete: !active,
    };
  }

  function activeReason(m, done) {
    const missing = (m.prerequisites || []).filter((p) => !done.has(p));
    if (missing.length > 0) return `Waiting on prerequisites: ${missing.join(', ')}`;
    const prev = milestones[milestones.findIndex((x) => x.id === m.id) - 1];
    if (prev && done.has(prev.id)) return `Previous milestone ${prev.id} done; next: ${m.id}`;
    return `Next curriculum milestone: ${m.id}`;
  }

  // Feed trusted primitive outcomes into session flags (table craft/place).
  // Pure data extraction — no LLM content involved.
  function noteOutcome(result) {
    try {
      if (result && result.ok === true && result.primitive === 'craft_item' && result.item === 'crafting_table') {
        return { craftedTable: true };
      }
      const placedItem = result && (result.item || result.block);
      if (result && result.ok === true && (result.primitive === 'place_block_nearby' || result.primitive === 'place_block') && placedItem === 'crafting_table') {
        return { placedTable: true };
      }
    } catch {
      // ignore
    }
    return null;
  }

  function reset() {
    history.clear();
    lastActiveId = null;
    firstTick = true;
    started = false;
  }

  return { tick, noteOutcome, reset, milestones };
}

module.exports = { createCurriculumManager };
