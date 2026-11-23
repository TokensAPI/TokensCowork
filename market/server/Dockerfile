# Self-hosted market backend. Build context is market/server/.
#
# Stage 1 builds the new console (admin-web/, served at /admin/next/): the locked dependencies are
# installed without running any package's install scripts, type-checked, and built into
# admin/next/. Stage 2 is the service as before: the business code and runtime, with zero npm
# dependencies at run time, plus that built folder copied over; nothing from stage 1's
# node_modules reaches the image.
FROM node:24-alpine AS admin-web
WORKDIR /build/admin-web
COPY admin-web/package.json admin-web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY admin-web/ ./
RUN npm run typecheck && npm run build

FROM node:24-alpine
WORKDIR /app
COPY . .
COPY --from=admin-web /build/admin/next ./admin/next
RUN test -s product-components.json && test -s admin/next/index.html && rm -rf admin-web && mkdir -p /data && chown node:node /data
USER node
ENV MARKET_HOST_DATA_DIR=/data
EXPOSE 8080
CMD ["node", "runtime/server.mjs"]
