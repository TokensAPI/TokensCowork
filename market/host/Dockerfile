# Self-hosted market backend. Build context is market/ (see docker-compose.yml)
# so the unchanged Cloudflare worker directory is copied verbatim; the runtime
# has zero npm dependencies, so there is no install step.
FROM node:24-alpine
WORKDIR /app
COPY server/ server/
COPY host/ host/
RUN mkdir -p /data && chown node:node /data
USER node
ENV MARKET_HOST_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "host/server.mjs"]
