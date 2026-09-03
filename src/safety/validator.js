'use strict';

// Strict allowlist validation. The LLM may only emit the five shapes
// documented in prompts.js; everything else is rejected.
function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, error: 'Action must be an object' };
  }
  if (typeof action.action !== 'string') {
    return { ok: false, error: 'Missing action name' };
  }

  switch (action.action) {
    case 'observe':
      return { ok: true, value: { action: 'observe' } };

    case 'collect_logs': {
      const amount = action.amount;
      if (!Number.isInteger(amount) || amount < 1 || amount > 8) {
        return { ok: false, error: 'collect_logs.amount must be an integer 1..8' };
      }
      return { ok: true, value: { action: 'collect_logs', amount } };
    }

    case 'chat': {
      if (typeof action.message !== 'string' || action.message.trim().length === 0) {
        return { ok: false, error: 'chat.message must be a non-empty string' };
      }
      if (action.message.length > 140) {
        return { ok: false, error: 'chat.message must be at most 140 characters' };
      }
      return { ok: true, value: { action: 'chat', message: action.message.trim() } };
    }

    case 'wait': {
      if (!Number.isInteger(action.seconds) || action.seconds < 1 || action.seconds > 10) {
        return { ok: false, error: 'wait.seconds must be an integer 1..10' };
      }
      return { ok: true, value: { action: 'wait', seconds: action.seconds } };
    }

    case 'finish': {
      if (typeof action.reason !== 'string' || action.reason.trim().length === 0) {
        return { ok: false, error: 'finish.reason must be a non-empty string' };
      }
      return { ok: true, value: { action: 'finish', reason: action.reason.trim().slice(0, 280) } };
    }

    default:
      return { ok: false, error: `Unknown action: ${action.action}` };
  }
}

module.exports = { validateAction };
