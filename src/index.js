/**
 * llm-exporter — entry point
 * Prometheus / VictoriaMetrics exporter for LLM rate limits & usage
 */
import { createServer } from 'node:http';
import { resolveConfig } from './config.js';
import { render } from './registry.js';
import { startScheduler } from './scheduler.js';

async function main() {
  console.info('[llm-exporter] starting...');

  const config = await resolveConfig();
  const { scrapeInterval, metricsPort } = config;

  console.info(`[llm-exporter] providers: ${[...config.providers.keys()].join(', ')}`);
  console.info(`[llm-exporter] scrape interval: ${scrapeInterval}s`);
  console.info(`[llm-exporter] metrics port: ${metricsPort}`);

  // Start probe scheduler
  const timer = startScheduler(config, scrapeInterval);

  // HTTP server for /metrics
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${metricsPort}`);

    if (url.pathname === '/metrics') {
      const body = render();
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>
        <h1>llm-exporter</h1>
        <p><a href="/metrics">Metrics</a></p>
        <p><a href="/health">Health</a></p>
      </body></html>`);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(metricsPort, () => {
    console.info(`[llm-exporter] listening on :${metricsPort}`);
  });

  // Graceful shutdown
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.info(`[llm-exporter] ${sig} received, shutting down...`);
      clearInterval(timer);
      server.close(() => process.exit(0));
    });
  }
}

main().catch(err => {
  console.error('[llm-exporter] fatal:', err);
  process.exit(1);
});
