/**
 * Base prober — HTTP helpers + common metric writers
 */
import * as reg from '../registry.js';

// ─── Gauges ───────────────────────────────────────────────────────────────────
export const g = {
  up:                reg.gauge('llm_key_up',                        'Key is alive (1) or auth error (0)'),
  cooldown:          reg.gauge('llm_key_cooldown',                  'Key is rate-limited or overloaded (1)'),
  reqRemaining:      reg.gauge('llm_rate_limit_requests_remaining', 'Remaining requests in current window'),
  reqLimit:          reg.gauge('llm_rate_limit_requests_limit',     'Total request limit per window'),
  tokRemaining:      reg.gauge('llm_rate_limit_tokens_remaining',   'Remaining tokens in current window'),
  tokLimit:          reg.gauge('llm_rate_limit_tokens_limit',       'Total token limit per window'),
  resetTs:           reg.gauge('llm_rate_limit_reset_timestamp',    'Unix timestamp of next rate limit reset'),
  probeCostUsd:      reg.gauge('llm_probe_cost_usd',                'Cost of last probe in USD (OAuth tokens only)'),
  creditsRemaining:  reg.gauge('llm_credits_remaining',             'Remaining credits in USD (OpenRouter)'),
  creditsTotal:      reg.gauge('llm_credits_total',                 'Total purchased credits in USD'),
  usageDaily:        reg.gauge('llm_usage_daily_usd',               'Daily usage in USD'),
  usageMonthly:      reg.gauge('llm_usage_monthly_usd',             'Monthly usage in USD'),
  charsRemaining:    reg.gauge('llm_characters_remaining',          'Remaining characters (ElevenLabs)'),
  charsLimit:        reg.gauge('llm_characters_limit',              'Character limit (ElevenLabs)'),
  charsReset:        reg.gauge('llm_characters_reset_timestamp',    'Unix timestamp of character reset'),
  probeDuration:     reg.gauge('llm_probe_duration_seconds',        'Duration of last probe in seconds'),
  ttft:              reg.gauge('llm_probe_ttft_seconds',            'Time to first token in seconds (XAI)'),
  scrapeSuccess:     reg.gauge('llm_scrape_success',                'Last scrape succeeded (1) or failed (0)'),
};

/**
 * Make an HTTP/HTTPS request
 * @returns {{ status, headers, body }}
 */
export async function httpRequest({ method = 'GET', url, headers = {}, body = null, timeoutMs = 10000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const opts = {
    method,
    headers,
    signal: controller.signal,
  };
  if (body) opts.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, opts);
    clearTimeout(timer);
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: resp.status, headers: resp.headers, body: json || text };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Parse a relative duration string to seconds (OpenAI format)
 * e.g. "6ms" → 0.006, "1m30s" → 90, "2h" → 7200
 */
export function parseRelativeDuration(str) {
  if (!str) return null;
  let total = 0;
  for (const [, val, unit] of str.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const v = parseFloat(val);
    switch (unit) {
      case 'ms': total += v / 1000; break;
      case 's':  total += v;        break;
      case 'm':  total += v * 60;   break;
      case 'h':  total += v * 3600; break;
    }
  }
  return total;
}

/**
 * Parse ISO8601 date string to epoch seconds (Anthropic format)
 */
export function parseIsoToEpoch(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : Math.floor(d.getTime() / 1000);
}

/**
 * Set common up/cooldown metrics
 */
export function setKeyStatus(labels, { up, cooldown }) {
  g.up.set(labels, up ? 1 : 0);
  g.cooldown.set(labels, cooldown ? 1 : 0);
}
