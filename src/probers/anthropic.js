/**
 * Anthropic prober — auto-detects key type by prefix:
 *   sk-ant-api03-* → API key   → POST /v1/messages with x-api-key
 *   sk-ant-oat01-* → OAuth token → @anthropic-ai/claude-code SDK (query)
 */
import { httpRequest, parseIsoToEpoch, setKeyStatus, g } from './base.js';

// ─── API Key prober ───────────────────────────────────────────────────────────

async function probeApiKey(provider, keyConf) {
  const labels = { provider: 'anthropic', key_id: keyConf.key_id, key_type: 'api', subscription: keyConf.subscription || 'api' };
  const t0 = Date.now();

  try {
    const { status, headers } = await httpRequest({
      method: 'POST',
      url: `${provider.base_url}/v1/messages`,
      headers: {
        'x-api-key':         keyConf.key,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: {
        model:      provider.probe_model,
        max_tokens: 1,
        messages:   [{ role: 'user', content: 'hi' }],
      },
    });

    g.probeDuration.set(labels, (Date.now() - t0) / 1000);

    if (status === 401 || status === 403) { setKeyStatus(labels, { up: false, cooldown: false }); return; }
    if (status === 429 || status === 529) {
      setKeyStatus(labels, { up: true, cooldown: true });
      const retryAfter = headers.get('retry-after');
      if (retryAfter) g.resetTs.set(labels, Math.floor(Date.now() / 1000) + parseInt(retryAfter));
      return;
    }

    setKeyStatus(labels, { up: true, cooldown: false });

    const hdr = (name) => headers.get(name);
    const reqLimit     = parseInt(hdr('x-ratelimit-limit-requests'));
    const reqRemaining = parseInt(hdr('x-ratelimit-remaining-requests'));
    const tokLimit     = parseInt(hdr('x-anthropic-ratelimit-input-tokens-limit')     || hdr('x-ratelimit-limit-tokens'));
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
    console.error(`[anthropic/api] probe error ${keyConf.key_id}: ${err.message}`);
  }
}

// ─── OAuth token prober (via claude CLI subprocess) ──────────────────────────

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Resolve claude CLI path relative to this file's package
const CLAUDE_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/@anthropic-ai/claude-code/cli.js'
);

function runClaudeCLI(token, model, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,   // node
      [CLAUDE_CLI, '-p', 'hi', '--output-format', 'json', '--max-turns', '1'],
      {
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
        timeout: timeoutMs,
      }
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      // Parse last JSON line from output
      const lines = stdout.trim().split('\n').filter(Boolean);
      let result = null;
      for (const line of lines.reverse()) {
        try { result = JSON.parse(line); break; } catch {}
      }
      resolve({ result, stderr });
    });

    proc.on('error', reject);
  });
}

async function probeOAuthToken(provider, keyConf) {
  const labels = { provider: 'anthropic', key_id: keyConf.key_id, key_type: 'oauth', subscription: keyConf.subscription || 'max' };
  const t0 = Date.now();

  try {
    const { result } = await runClaudeCLI(keyConf.key, provider.probe_model);

    g.probeDuration.set(labels, (Date.now() - t0) / 1000);

    if (!result) {
      setKeyStatus(labels, { up: false, cooldown: false });
      console.warn(`[anthropic/oauth] ${keyConf.key_id}: no result from CLI`);
      return;
    }

    const success = result.type === 'result' && result.subtype === 'success';
    const isRateLimit = result.subtype === 'error_during_execution' &&
      JSON.stringify(result).includes('429');

    setKeyStatus(labels, { up: success || isRateLimit, cooldown: isRateLimit });

    if (result.total_cost_usd != null) {
      g.probeCostUsd.set(labels, result.total_cost_usd);
    }

    console.debug(`[anthropic/oauth] ${keyConf.key_id}: ${result.subtype}, cost=$${result.total_cost_usd?.toFixed(6) ?? 'n/a'}`);

  } catch (err) {
    g.probeDuration.set(labels, (Date.now() - t0) / 1000);

    const isAuth     = /401|403|auth|invalid.*token/i.test(err.message);
    const isCooldown = /429|rate.limit/i.test(err.message);

    setKeyStatus(labels, { up: !isAuth, cooldown: isCooldown });
    console.error(`[anthropic/oauth] probe error ${keyConf.key_id}: ${err.message}`);
  }
}

// ─── Entry point — auto-detect key type ──────────────────────────────────────

export async function probe(provider, keyConf) {
  if (keyConf.key.startsWith('sk-ant-oat')) {
    return probeOAuthToken(provider, keyConf);
  } else {
    return probeApiKey(provider, keyConf);
  }
}
