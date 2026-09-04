'use strict';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function requestTimeoutMs() {
  // Observed live: without a timeout a stalled provider stream hangs the
  // agent loop silently forever (node fetch has no default timeout), and
  // the bot can die idle while awaiting its first plan. Bound it so the
  // planner circuit breaker + safe fallback can do their jobs instead.
  const v = parseInt(process.env.OPENROUTER_TIMEOUT_MS || '60000', 10);
  if (!Number.isFinite(v)) return 60000;
  return Math.max(5000, Math.min(v, 300000));
}

function getConfig() {
  return {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    appName: process.env.OPENROUTER_APP_NAME || 'AI Plays Minecraft',
  };
}

// Clean OpenRouter wrapper. The rest of the codebase never calls fetch
// directly; all OpenRouter specifics stay here.
async function complete(messages, options = {}) {
  const { apiKey, model, appName } = getConfig();
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY (copy .env.example to .env and set it)');
  }

  const finalModel = options.model || model;
  const body = {
    model: finalModel,
    messages,
    temperature: options.temperature ?? 0.2,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;

  let res;
  const startedAt = Date.now();
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': appName,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
  } catch (err) {
    throw new Error(`OpenRouter request failed: ${err && err.message ? err.message : err}`);
  }
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 15000) {
    // Slow calls are the early warning for provider stalls; normal calls
    // finish in seconds, so this stays quiet unless something is wrong.
    try {
      require('../telemetry/logger').logger.warn(`OpenRouter call took ${elapsedMs}ms (model=${finalModel}, status=${res && res.status})`);
    } catch {
      // telemetry must never break the request path
    }
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const snippet = text.slice(0, 500);
    throw new Error(`OpenRouter HTTP ${res.status}: ${snippet}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('OpenRouter returned invalid JSON');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('OpenRouter returned no assistant content');
  }

  return {
    content,
    model: data?.model || finalModel,
    usage: data?.usage || null,
  };
}

module.exports = { complete };
