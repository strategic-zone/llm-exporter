# llm-exporter

**Prometheus / VictoriaMetrics exporter for LLM provider rate limits and usage.**

Monitors Anthropic, OpenAI, OpenRouter, XAI, Mistral, Gemini, and ElevenLabs — exposes remaining rate limits, token budgets, credit balances, and key health as Prometheus metrics.

## Features

- **Multi-provider** — single exporter for all your LLM keys
- **Zero-cost probes** — uses minimal or free endpoints where possible (OpenRouter `/auth/key`, ElevenLabs `/v1/user`)
- **Dual config source** — YAML file + Supabase credentials table (Supabase takes priority)
- **Prometheus format** — `/metrics` endpoint, scrape with any compatible backend
- **Alerting-ready** — Alertmanager / Grafana alerts on `llm_key_cooldown` or low remaining tokens

## Quick Start

```bash
cp .env.example .env
cp config.example.yaml config.yaml
# Edit .env and config.yaml with your keys

# Create data directories (for full profile)
mkdir -p /opt/llm-exporter/victoriametrics /opt/llm-exporter/grafana

# Exporter only
docker compose up -d

# Full stack (+ VictoriaMetrics + Grafana)
docker compose --profile full up -d

# Metrics available at http://localhost:9090/metrics
```

## Auto-Update (Watchtower)

All containers include the `com.centurylinklabs.watchtower.enable=true` label.
If you run [Watchtower](https://containrrr.dev/watchtower/) on the same host, it will auto-update them:

```bash
docker run -d \
  --name watchtower \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  --label-enable \
  --cleanup \
  --schedule "0 0 4 * * 1"   # every Monday at 04:00
```

## Metrics

```
# Key health
llm_key_up{provider, key_id, subscription}              # 1=alive, 0=auth error
llm_key_cooldown{provider, key_id}                      # 1=rate limited / overloaded

# Rate limits (Anthropic, OpenAI, XAI, Mistral)
llm_rate_limit_requests_remaining{provider, key_id}
llm_rate_limit_requests_limit{provider, key_id}
llm_rate_limit_tokens_remaining{provider, key_id}
llm_rate_limit_tokens_limit{provider, key_id}
llm_rate_limit_reset_timestamp{provider, key_id}        # epoch seconds

# Credits / usage (OpenRouter)
llm_credits_remaining{provider, key_id}                 # USD
llm_usage_daily{provider, key_id}                       # USD
llm_usage_monthly{provider, key_id}                     # USD

# Characters (ElevenLabs)
llm_characters_remaining{provider, key_id}
llm_characters_limit{provider, key_id}

# Probe perf
llm_probe_duration_seconds{provider, key_id}
llm_scrape_success{provider}
```

## Config

See [AGENTS.md](./AGENTS.md) for architecture and provider-specific probe strategies.

Config is loaded from two sources (Supabase takes priority over YAML):

**Option A — YAML**
```yaml
# config.yaml
scrape_interval: 300
metrics_port: 9090

providers:
  - name: anthropic
    probe: post_chat
    base_url: https://api.anthropic.com
    probe_model: claude-haiku-4-5-20251001
    keys:
      - id: max-1
        key: sk-ant-xxx
        subscription: max

  - name: openrouter
    probe: auth_key
    base_url: https://openrouter.ai/api/v1
    keys:
      - id: main
        key: sk-or-v1-xxx
```

**Option B — Supabase**

Set `SUPABASE_URL` and `SUPABASE_KEY` in `.env`. The exporter reads from the `credentials` table:
- `provider` column → maps to provider name
- `name` column → `*_api_key` convention
- `scope` → `global`, `client`, or `instance`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `METRICS_PORT` | Port to expose `/metrics` (default: `9090`) |
| `SCRAPE_INTERVAL` | Seconds between probes (default: `300`) |
| `CONFIG_FILE` | Path to config YAML (default: `/app/config.yaml`) |
| `SUPABASE_URL` | Supabase project URL (optional) |
| `SUPABASE_KEY` | Supabase service role key (optional) |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` (default: `info`) |

## Grafana Dashboard

Import the included `grafana-dashboard.json` or create panels with:
- **Key health overview** — `llm_key_up` table by provider
- **Rate limit gauge** — `llm_rate_limit_requests_remaining / llm_rate_limit_requests_limit`
- **Cooldown alerts** — `llm_key_cooldown == 1`
- **OpenRouter spend** — `llm_usage_monthly`

## Provider Support Matrix

| Provider | Probe method | Headers | Free probe |
|----------|-------------|---------|-----------|
| Anthropic | POST /messages (1 token) | ✅ requests + tokens + reset | ❌ (micro cost) |
| OpenAI | POST /chat/completions (1 token) | ✅ requests + tokens + reset | ❌ (micro cost) |
| OpenRouter | GET /auth/key + /credits | ⚠️ not in headers | ✅ zero cost |
| XAI (Grok) | POST /chat/completions (1 token) | ✅ requests + tokens | ❌ (micro cost) |
| Mistral | POST /chat/completions (1 token) | ✅ tokens/min + req/min | ❌ (micro cost) |
| Gemini | POST generateContent | ⚠️ only service tier | ❌ (micro cost) |
| ElevenLabs | GET /v1/user | ✅ characters + reset | ✅ zero cost |

## License

MIT — Strategic Zone / Atlantic Zone
