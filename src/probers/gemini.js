import { httpRequest, setKeyStatus, g } from './base.js';

// Track which model works for each key (survives process restart via module state)
const workingModel = new Map();

export async function probe(provider, keyConf) {
  const labels = { provider: 'gemini', key_id: keyConf.key_id };
  const t0 = Date.now();

  const models = [
    workingModel.get(keyConf.key_id),
    provider.probe_model,
    ...(provider.probe_model_fallbacks || []),
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);  // dedupe

  let lastError = null;

  for (const model of models) {
    try {
      const url = `${provider.base_url}/models/${model}:generateContent?key=${keyConf.key}`;
      const { status, headers, body } = await httpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: {
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      });

      g.probeDuration.set(labels, (Date.now() - t0) / 1000);

      if (status === 401 || status === 403) {
        setKeyStatus(labels, { up: false, cooldown: false });
        return;
      }

      if (status === 404) {
        // Model deprecated — try next
        console.warn(`[gemini] model ${model} deprecated, trying fallback`);
        lastError = `model ${model} deprecated`;
        continue;
      }

      if (status === 429) {
        setKeyStatus(labels, { up: true, cooldown: true });
        // Try to parse retryDelay from error body
        const retryDelay = body?.error?.details?.[0]?.metadata?.retryDelay;
        if (retryDelay) {
          const secs = parseInt(retryDelay);
          if (!isNaN(secs)) g.resetTs.set(labels, Math.floor(Date.now() / 1000) + secs);
        }
        workingModel.set(keyConf.key_id, model);
        return;
      }

      // Success
      workingModel.set(keyConf.key_id, model);
      setKeyStatus(labels, { up: true, cooldown: false });

      // Gemini doesn't expose rate limit headers — only service tier
      // (nothing more to parse)
      return;

    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  // All models failed
  g.probeDuration.set(labels, (Date.now() - t0) / 1000);
  setKeyStatus(labels, { up: false, cooldown: false });
  console.error(`[gemini] all models failed for ${keyConf.key_id}: ${lastError}`);
}
