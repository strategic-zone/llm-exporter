import { httpRequest, setKeyStatus, g } from './base.js';

export async function probe(provider, keyConf) {
  const labels = { provider: 'elevenlabs', key_id: keyConf.key_id };
  const t0 = Date.now();

  try {
    // Free probe — no character cost
    const { status, body } = await httpRequest({
      url: `${provider.base_url}/v1/user`,
      headers: { 'xi-api-key': keyConf.key },
    });

    g.probeDuration.set(labels, (Date.now() - t0) / 1000);

    if (status === 401 || status === 403) {
      setKeyStatus(labels, { up: false, cooldown: false });
      return;
    }

    if (status === 429) {
      setKeyStatus(labels, { up: true, cooldown: true });
      return;
    }

    setKeyStatus(labels, { up: true, cooldown: false });

    const sub = body?.subscription || {};
    const limit = parseInt(sub.character_limit);
    const used  = parseInt(sub.character_count);
    const reset = sub.next_character_count_reset_unix;

    if (!isNaN(limit))  g.charsLimit.set(labels, limit);
    if (!isNaN(used) && !isNaN(limit)) g.charsRemaining.set(labels, limit - used);
    if (reset) g.charsReset.set(labels, parseInt(reset));

  } catch (err) {
    g.probeDuration.set(labels, (Date.now() - t0) / 1000);
    setKeyStatus(labels, { up: false, cooldown: false });
    console.error(`[elevenlabs] probe error ${keyConf.key_id}: ${err.message}`);
  }
}
