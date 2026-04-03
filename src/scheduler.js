/**
 * Probe scheduler — runs all probers on interval
 */
import * as reg from './registry.js';
import { probe as probeAnthropic }  from './probers/anthropic.js';
import { probe as probeOpenAI }     from './probers/openai.js';
import { probe as probeOpenRouter } from './probers/openrouter.js';
import { probe as probeXAI }        from './probers/xai.js';
import { probe as probeMistral }    from './probers/mistral.js';
import { probe as probeGemini }     from './probers/gemini.js';
import { probe as probeElevenLabs } from './probers/elevenlabs.js';

const PROBERS = {
  anthropic:   probeAnthropic,
  openai:      probeOpenAI,
  openrouter:  probeOpenRouter,
  xai:         probeXAI,
  mistral:     probeMistral,
  gemini:      probeGemini,
  google:      probeGemini,
  elevenlabs:  probeElevenLabs,
};

const scrapeSuccess = reg.gauge('llm_scrape_success', 'Last scrape succeeded (1) or failed (0)');
const scrapeTs      = reg.gauge('llm_last_scrape_timestamp', 'Unix timestamp of last scrape');

export async function runProbes(config) {
  const tasks = [];

  for (const [name, provider] of config.providers) {
    const prober = PROBERS[name];
    if (!prober) {
      console.warn(`[scheduler] no prober for provider: ${name}`);
      continue;
    }
    if (!provider.keys.length) {
      console.debug(`[scheduler] no keys for provider: ${name}`);
      continue;
    }

    for (const keyConf of provider.keys) {
      tasks.push(
        prober(provider, keyConf)
          .then(() => {
            scrapeSuccess.set({ provider: name }, 1);
          })
          .catch(err => {
            console.error(`[scheduler] ${name}/${keyConf.key_id} unhandled: ${err.message}`);
            scrapeSuccess.set({ provider: name }, 0);
          })
      );
    }
  }

  await Promise.allSettled(tasks);
  scrapeTs.set({}, Math.floor(Date.now() / 1000));

  console.info(`[scheduler] scrape done — ${tasks.length} probes`);
}

export function startScheduler(config, intervalSeconds) {
  console.info(`[scheduler] starting — interval: ${intervalSeconds}s, providers: ${[...config.providers.keys()].join(', ')}`);

  // Run immediately on start
  runProbes(config).catch(console.error);

  // Then on interval
  return setInterval(() => {
    runProbes(config).catch(console.error);
  }, intervalSeconds * 1000);
}
