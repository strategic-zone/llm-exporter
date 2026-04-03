/**
 * Prometheus metrics registry
 * Hand-rolled — no external client library
 */

const metrics = new Map();   // name → { type, help, samples: [{labels, value}] }

function labelStr(labels) {
  if (!labels || Object.keys(labels).length === 0) return '';
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
  return `{${parts.join(',')}}`;
}

export function gauge(name, help) {
  if (!metrics.has(name)) metrics.set(name, { type: 'gauge', help, samples: [] });
  return {
    set(labels, value) {
      const m = metrics.get(name);
      const key = JSON.stringify(labels);
      const idx = m.samples.findIndex(s => JSON.stringify(s.labels) === key);
      const entry = { labels, value };
      if (idx >= 0) m.samples[idx] = entry; else m.samples.push(entry);
    },
  };
}

export function counter(name, help) {
  if (!metrics.has(name)) metrics.set(name, { type: 'counter', help, samples: [] });
  return {
    inc(labels, amount = 1) {
      const m = metrics.get(name);
      const key = JSON.stringify(labels);
      const idx = m.samples.findIndex(s => JSON.stringify(s.labels) === key);
      if (idx >= 0) m.samples[idx].value += amount;
      else m.samples.push({ labels, value: amount });
    },
  };
}

export function render() {
  const lines = [];
  for (const [name, m] of metrics) {
    lines.push(`# HELP ${name} ${m.help}`);
    lines.push(`# TYPE ${name} ${m.type}`);
    for (const s of m.samples) {
      lines.push(`${name}${labelStr(s.labels)} ${s.value}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function clear(namePrefix) {
  for (const [name, m] of metrics) {
    if (name.startsWith(namePrefix)) m.samples = [];
  }
}
