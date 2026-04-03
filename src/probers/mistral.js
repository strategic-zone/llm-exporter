import { httpRequest, setKeyStatus, g } from './base.js';

export async function probe(provider, keyConf) {
  const labels = { provider: 'mistral', key_id: keyConf.key_id };
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
      // Mistral window = 1 minute
      g.resetTs.set(labels, Math.floor(Date.now() / 1000) + 60);
      return;
    }

    setKeyStatus(labels, { up: true, cooldown: false });

    const hdr = (name) => headers.get(name);

    const tokLimit     = parseInt(hdr('x-ratelimit-limit-tokens-minute'));
    const tokRemaining = parseInt(hdr('x-ratelimit-remaining-tokens-minute'));
    const reqLimit     = parseInt(hdr('x-ratelimit-limit-req-minute'));
    const reqRemaining = parseInt(hdr('x-ratelimit-remaining-req-minute'));

    if (!isNaN(tokLimit))     g.tokLimit.set(labels, tokLimit);
    if (!isNaN(tokRemaining)) g.tokRemaining.set(labels, tokRemaining);
    if (!isNaN(reqLimit))     g.reqLimit.set(labels, reqLimit);
    if (!isNaN(reqRemaining)) g.reqRemaining.set(labels, reqRemaining);

    // Mistral window = 1 min, always reset in ~60s
    g.resetTs.set(labels, Math.floor(Date.now() / 1000) + 60);

  } catch (err) {
    g.probeDuration.set(labels, (Date.now() - t0) / 1000);
    setKeyStatus(labels, { up: false, cooldown: false });
    console.error(`[mistral] probe error ${keyConf.key_id}: ${err.message}`);
  }
}
