import { httpRequest, parseRelativeDuration, setKeyStatus, g } from './base.js';

export async function probe(provider, keyConf) {
  const labels = { provider: 'openai', key_id: keyConf.key_id };
  const t0 = Date.now();

  try {
    const { status, headers } = await httpRequest({
      method: 'POST',
      url: `${provider.base_url}/chat/completions`,
      headers: {
        Authorization:  `Bearer ${keyConf.key}`,
        'Content-Type': 'application/json',
      },
      body: {
        model:      provider.probe_model,
        max_tokens: 1,
        messages:   [{ role: 'user', content: 'hi' }],
      },
    });

    g.probeDuration.set(labels, (Date.now() - t0) / 1000);

    if (status === 401 || status === 403) {
      setKeyStatus(labels, { up: false, cooldown: false });
      return;
    }

    if (status === 429) {
      setKeyStatus(labels, { up: true, cooldown: true });
      const retryAfter = headers.get('retry-after');
      if (retryAfter) {
        const secs = parseRelativeDuration(retryAfter) || parseFloat(retryAfter);
        if (secs) g.resetTs.set(labels, Math.floor(Date.now() / 1000) + secs);
      }
      return;
    }

    setKeyStatus(labels, { up: true, cooldown: false });

    const hdr = (name) => headers.get(name);

    const reqLimit      = parseInt(hdr('x-ratelimit-limit-requests'));
    const reqRemaining  = parseInt(hdr('x-ratelimit-remaining-requests'));
    const tokLimit      = parseInt(hdr('x-ratelimit-limit-tokens'));
    const tokRemaining  = parseInt(hdr('x-ratelimit-remaining-tokens'));
    const resetReqStr   = hdr('x-ratelimit-reset-requests');
    const resetTokStr   = hdr('x-ratelimit-reset-tokens');

    if (!isNaN(reqLimit))    g.reqLimit.set(labels, reqLimit);
    if (!isNaN(reqRemaining)) g.reqRemaining.set(labels, reqRemaining);
    if (!isNaN(tokLimit))    g.tokLimit.set(labels, tokLimit);
    if (!isNaN(tokRemaining)) g.tokRemaining.set(labels, tokRemaining);

    const resetSecs = parseRelativeDuration(resetReqStr || resetTokStr);
    if (resetSecs != null) g.resetTs.set(labels, Math.floor(Date.now() / 1000) + resetSecs);

  } catch (err) {
    g.probeDuration.set(labels, (Date.now() - t0) / 1000);
    setKeyStatus(labels, { up: false, cooldown: false });
    console.error(`[openai] probe error ${keyConf.key_id}: ${err.message}`);
  }
}
