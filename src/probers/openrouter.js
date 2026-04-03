import { httpRequest, setKeyStatus, g } from './base.js';

export async function probe(provider, keyConf) {
  const labels = { provider: 'openrouter', key_id: keyConf.key_id };
  const t0 = Date.now();

  try {
    // Free probe — no token cost
    const [authResp, creditsResp] = await Promise.all([
      httpRequest({
        url: `${provider.base_url}/auth/key`,
        headers: { Authorization: `Bearer ${keyConf.key}` },
      }),
      httpRequest({
        url: `${provider.base_url}/credits`,
        headers: { Authorization: `Bearer ${keyConf.key}` },
      }),
    ]);

    g.probeDuration.set(labels, (Date.now() - t0) / 1000);

    if (authResp.status === 401 || authResp.status === 403) {
      setKeyStatus(labels, { up: false, cooldown: false });
      return;
    }

    setKeyStatus(labels, { up: true, cooldown: false });

    // /auth/key response
    const d = authResp.body?.data || {};
    if (d.usage_daily   != null) g.usageDaily.set(labels,   parseFloat(d.usage_daily));
    if (d.usage_monthly != null) g.usageMonthly.set(labels, parseFloat(d.usage_monthly));

    // /credits response
    const c = creditsResp.body?.data || {};
    if (c.total_credits != null && c.total_usage != null) {
      g.creditsTotal.set(labels,     parseFloat(c.total_credits));
      g.creditsRemaining.set(labels, parseFloat(c.total_credits) - parseFloat(c.total_usage));
    }

    // Rate limit from auth/key (deprecated but still present)
    if (d.limit != null)           g.reqLimit.set(labels,     parseFloat(d.limit));
    if (d.limit_remaining != null) g.reqRemaining.set(labels, parseFloat(d.limit_remaining));

  } catch (err) {
    g.probeDuration.set(labels, (Date.now() - t0) / 1000);
    setKeyStatus(labels, { up: false, cooldown: false });
    console.error(`[openrouter] probe error ${keyConf.key_id}: ${err.message}`);
  }
}
