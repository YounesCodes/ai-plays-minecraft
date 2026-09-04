#!/usr/bin/env node
'use strict';

// Live planner A/B harness: calls the CURRENT planAutonomous over varied
// REAL perception contexts and reports valid/invalid + categories.
// Compares against the historical rich-contract baseline (25-40% invalid).
// Never prints secrets — only counts and error categories.
//
// Usage (on VM): node scripts/eval-planner-ab.cjs [--user EvalBot01] [--calls 35]

const mineflayer = require('mineflayer');
const { observe } = require('../src/bot/observations');
const { buildContext } = require('../src/agent/context');
const { planAutonomous, AUTONOMOUS_CONTRACT } = require('../src/agent/planner');
const { categorizePlannerError } = require('../src/agent/cognition');
const skillLibrary = require('../src/skills/library');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HOST = process.env.MC_HOST || arg('--host', '127.0.0.1');
const PORT = parseInt(process.env.MC_PORT || arg('--port', '25565'), 10);
const USER = arg('--user', 'EvalBot01');
const VERSION = process.env.MC_VERSION || '1.21.11';
const TOTAL = parseInt(arg('--calls', '35'), 10);

const LAST_RESULTS = [
  null,
  { ok: false, primitive: 'mine_block_type', reason: 'no_reachable_target', requiresRelocation: true, candidatesSeen: 30, candidatesDeferred: 18, nearestDeferredDistance: 31.2 },
  { ok: false, primitive: 'find_block', reason: 'resource_not_seen', blockType: 'oak_log' },
  { ok: true, primitive: 'mine_block_type', block: 'oak_log', broken: 2, dropCollected: true },
  { ok: false, primitive: 'mine_block_type', reason: 'no_reachable_target', requiresRelocation: false, candidatesSeen: 4 },
];

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USER, version: VERSION });

bot.once('spawn', async () => {
  const stats = { valid: 0, invalid: 0, categories: {}, decisions: [] };
  try {
    await new Promise((r) => setTimeout(r, 3000));
    let knownSkillNames = [];
    try {
      knownSkillNames = skillLibrary.list().map((s) => s.name).concat(skillLibrary.list().map((s) => s.id));
    } catch {}
    console.log(JSON.stringify({ eval: 'planner-ab', contract: AUTONOMOUS_CONTRACT, model: process.env.OPENROUTER_MODEL || null, calls: TOTAL }));
    // Capture several live snapshots spaced out (world changes around us).
    const snapshots = [];
    const nSnap = Math.min(7, TOTAL);
    for (let i = 0; i < nSnap; i++) {
      try {
        snapshots.push(observe(bot, {}));
      } catch (e) {
        snapshots.push(null);
      }
      await new Promise((r) => setTimeout(r, 8000));
    }
    let call = 0;
    outer: for (const perception of snapshots) {
      if (!perception) continue;
      for (const lastResult of LAST_RESULTS) {
        if (call >= TOTAL) break outer;
        call += 1;
        const context = buildContext({
          directive: process.env.AGENT_DIRECTIVE || 'Survive and progress.',
          goalState: { currentGoal: { description: 'Gather wood and establish a foothold', priority: 60 }, subgoals: [], suspendedGoal: null },
          perception,
          lastResult,
          recentEvents: [],
          relevantMemories: { semantic: [], episodic: [], procedural: [], world: [] },
          availableSkills: [],
          exploration: { localSearchExhausted: !!(lastResult && lastResult.requiresRelocation) },
          deathSignal: null,
        });
        try {
          const { decision } = await planAutonomous({ context, knownSkillNames, temperature: 0.4 });
          stats.valid += 1;
          stats.decisions.push({ call, ok: true, next: `${decision.nextStep.type}:${decision.nextStep.name}`, goalChange: !!decision.goalChange });
        } catch (err) {
          const cat = /non-JSON|invalid JSON/i.test(String(err && err.message)) ? 'parse-failure' : categorizePlannerError(err);
          stats.invalid += 1;
          stats.categories[cat] = (stats.categories[cat] || 0) + 1;
          stats.decisions.push({ call, ok: false, category: cat, msg: String(err && (err.validationError || err.message)).slice(0, 160) });
        }
        console.log(JSON.stringify({ progress: `${call}/${TOTAL}`, ...stats.decisions[stats.decisions.length - 1] }));
      }
    }
    const total = stats.valid + stats.invalid;
    console.log(JSON.stringify({
      summary: true, contract: AUTONOMOUS_CONTRACT,
      valid: stats.valid, invalid: stats.invalid,
      invalidPct: total ? Math.round((stats.invalid / total) * 1000) / 10 : null,
      categories: stats.categories,
    }));
    bot.quit(); process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ error: String((err && err.message) || err).slice(0, 300) }));
    try { bot.quit(); } catch {}
    process.exit(1);
  }
});
bot.on('error', (e) => console.error(JSON.stringify({ botError: String((e && e.message) || e).slice(0, 120) })));
setTimeout(() => { console.error('timeout'); process.exit(2); }, 1200000);
