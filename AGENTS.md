# AGENTS.md — Architecture & Provider Probe Strategies

*Internal knowledge base for llm-exporter development and maintenance.*
*Last updated: 2026-04-03 — tested against live APIs*

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     llm-exporter (Node.js)                      │
│                                                                 │
│  Config resolver (on startup + hot-reload every 10min):        │
│  ├── 1. Supabase credentials table (if SUPABASE_URL set)       │
│  └── 2. config.yaml (fallback / merge)                         │
│                                                                 │
│  ProbeScheduler (scrape_interval):                              │
│  ├── AnthropicProber    → POST /v1/messages (1 token)          │
│  ├── OpenAIProber       → POST /v1/chat/completions (1 token)  │
│  ├── OpenRouterProber   → GET /auth/key + GET /credits         │
│  ├── XAIProber          → POST /v1/chat/completions (1 token)  │
│  ├── MistralProber      → POST /v1/chat/completions (1 token)  │
│  ├── GeminiProber       → POST generateContent (1 token)       │
│  └── ElevenLabsProber   → GET /v1/user                        │
│                                                                 │
│  MetricsRegistry → /metrics (Prometheus text format)           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Provider Probe Strategies

### Anthropic

- **Endpoint:** `POST /v1/messages`
- **Model:** `claude-haiku-4-5-20251001` (cheapest)
- **Body:** `{ model, max_tokens: 1, messages: [{role: "user", content: "hi"}] }`
- **Headers to parse:**
  ```
  x-ratelimit-limit-requests
  x-ratelimit-remaining-requests
  x-ratelimit-limit-tokens
  x-ratelimit-remaining-tokens
  x-ratelimit-reset-requests    → ISO8601 → epoch seconds
  x-ratelimit-reset-tokens      → ISO8601 → epoch seconds
  x-anthropic-ratelimit-input-tokens-limit
  x-anthropic-ratelimit-input-tokens-remaining
  x-anthropic-ratelimit-output-tokens-limit
  x-anthropic-ratelimit-output-tokens-remaining
  ```
- **HTTP 429** → `llm_key_cooldown = 1` (rate limited)
- **HTTP 529** → `llm_key_cooldown = 1` (overloaded — different from rate limit)
- **HTTP 401/403** → `llm_key_up = 0`
- **Note:** Max/Pro subscriptions have higher limits but same header structure

### OpenAI

- **Endpoint:** `POST /v1/chat/completions`
- **Model:** `gpt-4o-mini` (cheapest)
- **Headers to parse:**
  ```
  x-ratelimit-limit-requests
  x-ratelimit-remaining-requests
  x-ratelimit-limit-tokens
  x-ratelimit-remaining-tokens
  x-ratelimit-reset-requests    → relative duration ("6ms", "1m30s") → parse to seconds
  x-ratelimit-reset-tokens
  ```
- **Reset format:** relative strings — parser needed:
  ```
  "6ms" → 0.006s
  "1s" → 1s
  "1m30s" → 90s
  "1h2m3s" → 3723s
  ```

### OpenRouter ⭐ (preferred — free probing)

- **Primary endpoint:** `GET /api/v1/auth/key` (no token cost)
- **Secondary endpoint:** `GET /api/v1/credits` (balance)
- **Response fields from /auth/key:**
  ```json
  {
    "data": {
      "usage": 13.15,            // USD total
      "usage_daily": 0.05,
      "usage_weekly": 1.2,
      "usage_monthly": 13.15,
      "limit": null,             // null = unlimited
      "limit_remaining": null,
      "limit_reset": null,       // ISO8601 or null
      "expires_at": null,
      "is_free_tier": false,
      "rate_limit": { "requests": -1, "interval": "10s" }
    }
  }
  ```
- **Response from /credits:**
  ```json
  {
    "data": {
      "total_credits": 57.0,    // USD purchased
      "total_usage": 13.15      // USD spent
    }
  }
  ```
- **Derived metric:** `credits_remaining = total_credits - total_usage`
- **Note:** Rate limit in `rate_limit.requests` = -1 means unlimited; field is deprecated

### XAI (Grok)

- **Endpoint:** `POST /v1/chat/completions`
- **Model:** `grok-3-mini` (cheapest)
- **Headers to parse:**
  ```
  x-ratelimit-limit-requests       → typically 1400/window
  x-ratelimit-remaining-requests
  x-ratelimit-limit-tokens         → typically 4000000/window
  x-ratelimit-remaining-tokens
  x-metrics-ttft-ms                → time to first token (perf)
  x-metrics-e2e-ms                 → end-to-end latency (perf)
  ```
- **No reset header** — window duration unknown, infer from limit refresh
- **Note:** Very high limits (4M tokens) — likely daily window

### Mistral

- **Endpoint:** `POST /v1/chat/completions`
- **Model:** `mistral-small-latest`
- **Headers to parse:**
  ```
  x-ratelimit-limit-tokens-minute
  x-ratelimit-remaining-tokens-minute
  x-ratelimit-tokens-query-cost      → tokens consumed by this probe
  x-ratelimit-limit-req-minute
  x-ratelimit-remaining-req-minute
  ```
- **Window:** 1 minute (always reset in ~60s)
- **No reset header** — treat reset as `now + 60s`

### Gemini (Google)

- **Endpoint:** `POST /v1beta/models/{model}:generateContent?key={api_key}`
- **Model:** `gemini-2.5-flash` (check availability — models deprecate frequently)
- **Headers:** Only `X-Gemini-Service-Tier: standard|premium` — no rate limit info
- **Strategy:** Track HTTP 429 responses only
  - 429 body contains: `error.details[].metadata.retryDelay` (e.g., `"60s"`)
  - Set `llm_key_cooldown = 1` and `llm_rate_limit_reset_timestamp = now + retryDelay`
- **Model deprecation:** 404 = model no longer available → alert + failover to next model
- **Model fallback order:** `gemini-2.5-flash` → `gemini-1.5-flash` → `gemini-2.5-flash-lite`

### ElevenLabs ⭐ (free probing)

- **Endpoint:** `GET /v1/user`
- **Auth:** `xi-api-key: {key}` header
- **Response fields:**
  ```json
  {
    "subscription": {
      "character_count": 45000,
      "character_limit": 100000,
      "next_character_count_reset_unix": 1746057600
    }
  }
  ```
- **Metrics:**
  - `llm_characters_remaining = character_limit - character_count`
  - `llm_characters_limit = character_limit`
  - `llm_characters_reset_timestamp = next_character_count_reset_unix`

### Deepgram (TODO)

- **Endpoint:** `GET /v1/projects/{project_id}/usage`
- **Auth:** `Authorization: Token {key}`
- **Note:** Requires `project_id` — store in config alongside key
- **Available:** minutes transcribed, requests count (usage history, not rate limits)

---

## Supabase Integration

### Credentials table schema
```sql
credentials (
  id          uuid PRIMARY KEY,
  name        text,         -- e.g. 'anthropic_api_key', 'openrouter_api_key'
  provider    text,         -- e.g. 'anthropic', 'openrouter'
  scope       text,         -- 'global', 'client', 'instance'
  client_id   uuid,
  instance_id uuid,
  value       text,
  active      boolean
)
```

### Query to fetch all active API keys
```sql
SELECT id, name, provider, scope, value, client_id, instance_id
FROM credentials
WHERE active = true
  AND provider IN ('anthropic','openai','openrouter','xai','mistral','google','elevenlabs')
  AND name LIKE '%_api_key'
ORDER BY provider, scope;
```

### Key ID generation
`key_id` label = `{scope}-{id[0:8]}` (e.g., `global-e01b8860`, `instance-02d95b2b`)

---

## Error Handling

| HTTP Status | Provider | Action |
|-------------|----------|--------|
| 200 | Any | Parse headers, `key_up=1`, `cooldown=0` |
| 429 | Any | `cooldown=1`, parse retry-after if available |
| 529 | Anthropic | `cooldown=1` (overloaded, not rate limited) |
| 401/403 | Any | `key_up=0`, alert |
| 404 | Gemini | Model deprecated, try fallback model |
| 5xx | Any | `scrape_success=0`, retry next interval |
| Timeout | Any | `scrape_success=0`, log warning |

---

## Cost Estimation

Probing all keys every 5 minutes (300s), 24h/day:

| Provider | Cost per probe | Probes/day | Daily cost |
|----------|---------------|------------|------------|
| Anthropic | ~$0.000025 | 288 | ~$0.007 |
| OpenAI | ~$0.00001 | 288 | ~$0.003 |
| OpenRouter | $0 (free endpoint) | 288 | $0 |
| XAI | ~$0.00001 | 288 | ~$0.003 |
| Mistral | ~$0.000005 | 288 | ~$0.001 |
| Gemini | ~$0.000001 | 288 | ~$0.0003 |
| ElevenLabs | $0 (free endpoint) | 288 | $0 |

**Total per key, per day: ~$0.015**
For 10 keys across all providers: **~$0.15/day** ($4.50/month)

---

## Development Notes

- Node.js 22+ (ESM)
- No heavy frameworks — `node:http` for the metrics server, `node:https` for probing
- Prometheus text format: hand-rolled (no client library dependency)
- Hot-reload config from Supabase every 10min without restart
- Graceful shutdown: flush final metrics before exit

---

*Strategic Zone / Atlantic Zone — internal tooling*

---

## Key Sources — Décision d'architecture

**Source unique des clés : `config.yaml`**
Les clés API sont déclarées dans `config.yaml` uniquement.
Le `.env` ne contient jamais de clés — uniquement la config runtime.

```
.env          → METRICS_PORT, SCRAPE_INTERVAL, DATA_DIR, LOG_LEVEL
config.yaml   → providers + keys (source of truth)
Supabase      → optionnel, désactivé par défaut
```

### Activer Supabase comme source de clés

Quand Supabase est activé, il **complète** les clés de `config.yaml` (ou les remplace si même key_id).

**1. Décommenter dans `.env` :**
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=sb_secret_your_service_role_key_here
```

**2. Redémarrer le container :**
```bash
docker compose restart llm-exporter
```

**3. Vérifier dans les logs :**
```bash
docker logs llm-exporter | grep "supabase\|provider"
# Doit afficher les providers avec les clés Supabase chargées
```

### Désactiver Supabase

**1. Vider les variables dans `.env` :**
```env
SUPABASE_URL=
SUPABASE_KEY=
```

**2. Redémarrer :**
```bash
docker compose restart llm-exporter
```

→ L'exporter retombe automatiquement sur `config.yaml` seul.

### Mapping Supabase → providers

La table `credentials` est lue avec ce filtre :
```sql
SELECT * FROM credentials
WHERE active = true
  AND provider IN ('anthropic','openai','openrouter','xai','mistral','google','gemini','elevenlabs')
ORDER BY provider, scope;
```

Le `key_id` Prometheus est généré : `{scope}-{id[0:8]}` (ex: `global-e01b8860`)
