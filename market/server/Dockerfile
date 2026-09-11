# Self-hosted market backend. Build context is market/server/.
# The business code and runtime are packaged together; the runtime
# has zero npm dependencies, so there is no install step.
FROM node:24-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown node:node /data
USER node
ENV MARKET_HOST_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "runtime/server.mjs"]
