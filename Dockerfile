FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
RUN npm install --global --no-audit --no-fund npm@11.6.2
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_WUWATERM_BASE_PATH=""
ENV NEXT_PUBLIC_WUWATERM_BASE_PATH=${NEXT_PUBLIC_WUWATERM_BASE_PATH} \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build:selfhost

FROM node:24.22.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.1 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next-selfhost/standalone ./
USER node
CMD ["node", "server.js"]
