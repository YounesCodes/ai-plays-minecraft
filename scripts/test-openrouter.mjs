'use strict';

// Smoke-test the OpenRouter API key / model without starting the bot.
// Usage: npm run test:openrouter
// Reads .env via Node's env-file support (never committed, never logged).

try {
  process.loadEnvFile('.env');
} catch {
  // No .env: fall back to the real environment.
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Set OPENROUTER_API_KEY in .env first (copy .env.example to .env).');
  process.exit(2);
}
const model = process.env.OPENROUTER_MODEL || 'openrouter/free';
const appName = process.env.OPENROUTER_APP_NAME || 'AI Plays Minecraft';

(async () => {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': appName,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      temperature: 0,
    }),
  });
  const text = await res.text();
  process.stdout.write(`${text.slice(0, 2000)}\n`);
})().catch((err) => {
  console.error(`OpenRouter request failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
