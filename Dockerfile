FROM node:22-alpine

LABEL org.opencontainers.image.title="llm-exporter"
LABEL org.opencontainers.image.description="Prometheus exporter for LLM provider rate limits and usage"
LABEL org.opencontainers.image.source="https://github.com/strategic-zone/llm-exporter"

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/
COPY config.example.yaml ./config.example.yaml

# Non-root user
RUN addgroup -S exporter && adduser -S exporter -G exporter
USER exporter

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${METRICS_PORT:-9090}/health || exit 1

CMD ["node", "src/index.js"]
