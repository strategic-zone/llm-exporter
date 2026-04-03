import { httpRequest, parseIsoToEpoch, setKeyStatus, g } from './base.js';

export async function probe(provider, keyConf) {
  const labels = { provider: 'anthropic', key_id: keyConf.key_id, subscription: keyConf.subscription || 'api' };
  const t0 = Date.now();

  try {
    const { status, headers } = await httpRequest({
      method: 'POST',
      url: `${provider.base_url}/v1/messages`,
      headers: {
        'x-api-key':          keyConf.key,
        'anthropic-version':  '2023-06-01',
        'Content-Type':       'application/json',
      },
      body: {
        model:     provider.probe_model,
        max_tokens: 1,
        messages:  [{ role: 'user', content: 'hi' }],
      },
    });

    g.probeDuration.set(labels, (Date.now() - t0) / 1000);

    // 401/403 = bad key
    if (status === 401 || status === 403) {
      setKeyStatus(labels, { up: false, cooldown: false });
      return;
    }

    // 429 = rate limited | 529 = overloaded
    if (status === 429 || status === 529) {
      setKeyStatus(labels, { up: true, cooldown: true });
      const retryAfter = headers.get('retry-after');
      if (retryAfter) {
        g.resetTs.set(labels, Math.floor(Date.now() / 1000) + parseInt(retryAfter));
      }
      return;
    }

    // 200 or any success
    setKeyStatus(labels, { up: true, cooldown: false });

    const hdr = (name) => headers.get(name);

    const reqLimit     = parseInt(hdr('x-ratelimit-limit-requests'));
    const reqRemaining = parseInt(hdr('x-ratelimit-remaining-requests'));
    const tokLimit     = parseInt(hdr('x-anthropic-ratelimit-input-tokens-limit') || hdr('x-ratelimit-limit-tokens'));
    const tokRemaining = parseInt(hdr('x-anthropic-ratelimit-input-tokens-remaining') || hdr('x-ratelimit-remaining-tokens'));
    const resetReq     = parseIsoToEpoch(hdr('x-ratelimit-reset-requests'));
    const resetTok     = parseIsoToEpoch(hdr('x-anthropic-ratelimit-input-tokens-reset') || hdr('x-ratelimit-reset-tokens'));

    if (!isNaN(reqLimit))     g.reqLimit.set(labels, reqLimit);
    if (!isNaN(reqRemaining)) g.reqRemaining.set(labels, reqRemaining);
    if (!isNaN(tokLimit))     g.tokLimit.set(labels, tokLimit);
    if (!isNaN(tokRemaining)) g.tokRemaining.set(labels, tokRemaining);
    if (resetReq)             g.resetTs.set(labels, resetReq);
    else if (resetTok)        g.resetTs.set(labels, resetTok);

  } catch (err) {
    g.probeDuration.set(labels, (Date.now() - t0) / 1000);
    setKeyStatus(labels, { up: false, cooldown: false });
    console.error(`[anthropic] probe error ${keyConf.key_id}: ${err.message}`);
  }
}
