'use strict';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

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
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': appName,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`OpenRouter request failed: ${err && err.message ? err.message : err}`);
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
