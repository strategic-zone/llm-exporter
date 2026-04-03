/**
 * Config resolver — merges YAML file + Supabase credentials
 * Supabase takes priority over YAML keys
 */
import { readFileSync } from 'node:fs';
import yamlPkg from 'js-yaml';
const { load: yamlLoad } = yamlPkg;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CONFIG_FILE  = process.env.CONFIG_FILE || '/app/config.yaml';

// Provider name → probe strategy mapping (from Supabase provider field)
const PROBE_STRATEGY = {
  anthropic:   'post_chat',
  openai:      'post_chat',
  openrouter:  'auth_key',
  xai:         'post_chat',
  mistral:     'post_chat',
  google:      'post_generate',
  gemini:      'post_generate',
  elevenlabs:  'user_endpoint',
  deepgram:    'usage_endpoint',
};

const PROVIDER_DEFAULTS = {
  anthropic:  { base_url: 'https://api.anthropic.com',                       probe_model: 'claude-haiku-4-5-20251001' },
  openai:     { base_url: 'https://api.openai.com/v1',                       probe_model: 'gpt-4o-mini' },
  openrouter: { base_url: 'https://openrouter.ai/api/v1',                    probe_model: null },
  xai:        { base_url: 'https://api.x.ai/v1',                             probe_model: 'grok-3-mini' },
  mistral:    { base_url: 'https://api.mistral.ai/v1',                       probe_model: 'mistral-small-latest' },
  google:     { base_url: 'https://generativelanguage.googleapis.com/v1beta', probe_model: 'gemini-2.5-flash' },
  gemini:     { base_url: 'https://generativelanguage.googleapis.com/v1beta', probe_model: 'gemini-2.5-flash' },
  elevenlabs: { base_url: 'https://api.elevenlabs.io',                       probe_model: null },
};

/**
 * Load config from YAML file
 * @returns {{ scrape_interval: number, metrics_port: number, providers: Array }}
 */
function loadYaml() {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    return yamlLoad(raw) || {};
  } catch {
    return {};
  }
}

/**
 * Load keys from Supabase credentials table
 * Returns array of { provider, key_id, key, scope, subscription }
 */
async function loadSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  try {
    const url = `${SUPABASE_URL}/rest/v1/credentials?select=id,name,provider,scope,value,client_id,instance_id&active=eq.true&order=provider`;
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!resp.ok) throw new Error(`Supabase ${resp.status}`);
    const rows = await resp.json();

    // Filter to API keys only (name ends with _api_key or is a known token)
    return rows
      .filter(r => r.value && r.value !== 'placeholder' && r.provider)
      .map(r => ({
        provider:     r.provider,
        key_id:       `${r.scope}-${r.id.slice(0, 8)}`,
        key:          r.value,
        scope:        r.scope,
        subscription: null,  // not stored in Supabase currently
      }));
  } catch (err) {
    console.error(`[config] Supabase load failed: ${err.message}`);
    return [];
  }
}

/**
 * Merge YAML config + Supabase keys into a normalized providers map
 * @returns {{ scrapeInterval: number, metricsPort: number, providers: Map<string, ProviderConfig> }}
 */
export async function resolveConfig() {
  const yaml = loadYaml();
  const sbKeys = await loadSupabase();

  const scrapeInterval = parseInt(process.env.SCRAPE_INTERVAL || yaml.scrape_interval || 300);
  const metricsPort    = parseInt(process.env.METRICS_PORT    || yaml.metrics_port    || 9090);

  // Build providers map from YAML first
  const providers = new Map();

  for (const p of (yaml.providers || [])) {
    const name = p.name;
    const defaults = PROVIDER_DEFAULTS[name] || {};
    providers.set(name, {
      name,
      probe:        p.probe         || PROBE_STRATEGY[name]  || 'post_chat',
      base_url:     p.base_url      || defaults.base_url,
      probe_model:  p.probe_model   || defaults.probe_model,
      probe_model_fallbacks: p.probe_model_fallbacks || [],
      keys: (p.keys || []).map(k => ({
        key_id:       k.id,
        key:          k.key,
        subscription: k.subscription || null,
      })),
    });
  }

  // Merge Supabase keys — add to existing providers or create new ones
  for (const sk of sbKeys) {
    const name = sk.provider === 'google' ? 'gemini' : sk.provider;
    const defaults = PROVIDER_DEFAULTS[name] || {};

    if (!providers.has(name)) {
      providers.set(name, {
        name,
        probe:       PROBE_STRATEGY[name] || 'post_chat',
        base_url:    defaults.base_url,
        probe_model: defaults.probe_model,
        probe_model_fallbacks: [],
        keys: [],
      });
    }

    const p = providers.get(name);
    // Supabase key wins — replace if same key_id, otherwise add
    const existing = p.keys.findIndex(k => k.key_id === sk.key_id);
    if (existing >= 0) {
      p.keys[existing] = sk;
    } else {
      p.keys.push(sk);
    }
  }

  // Also load inline env vars: LLM_{PROVIDER}_{KEY_ID}=value
  // Provider can contain underscores (e.g. LLM_AI_AZONE_MAIN → provider=ai-azone, key_id=main)
  const KNOWN_PROVIDER_NAMES = new Set([
    'anthropic','openai','openrouter','xai','mistral','gemini','google',
    'elevenlabs','deepgram','ai_azone','modal','brave',
  ]);
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith('LLM_') || !envVal) continue;
    const rest = envKey.slice(4); // strip LLM_
    const parts = rest.split('_');
    // Find longest prefix that matches a known provider
    let name = null, key_id = null;
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join('_').toLowerCase();
      if (KNOWN_PROVIDER_NAMES.has(candidate)) {
        name = candidate.replace(/_/g, '-');  // ai_azone → ai-azone
        key_id = parts.slice(i).join('_').toLowerCase();
        break;
      }
    }
    // Fallback: last part = key_id, rest = provider
    if (!name) {
      name = parts.slice(0, -1).join('_').toLowerCase().replace(/_/g, '-');
      key_id = parts[parts.length - 1].toLowerCase();
    }
    if (!name || !key_id) continue;
    const defaults = PROVIDER_DEFAULTS[name] || {};

    if (!providers.has(name)) {
      providers.set(name, {
        name,
        probe:       PROBE_STRATEGY[name] || 'post_chat',
        base_url:    defaults.base_url,
        probe_model: defaults.probe_model,
        probe_model_fallbacks: [],
        keys: [],
      });
    }
    const p = providers.get(name);
    if (!p.keys.find(k => k.key_id === key_id)) {
      p.keys.push({ key_id, key: envVal, subscription: null });
    }
  }

  return { scrapeInterval, metricsPort, providers };
}
