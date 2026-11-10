# Cadence: Home Assistant app image. The Supervisor builds this on the device
# with this folder as the build context. No BUILD_FROM: since Supervisor
# 2026.04 the base image must be named here.
ARG NODE_IMAGE=node:24.11.1-alpine3.22

# ---- build: compile the server (TypeScript) and the web app (Vite) ----
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server/ server/
COPY web/ web/
RUN npm run build

# ---- production dependencies of the server only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server --no-audit --no-fund && mkdir -p server/node_modules

# ---- runtime ----
FROM ${NODE_IMAGE}
ARG BUILD_ARCH
ARG BUILD_VERSION
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=deps /src/server/node_modules ./server/node_modules
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/web/dist ./web/dist
COPY run.sh /run.sh
RUN chmod a+x /run.sh

LABEL \
  io.hass.name="Cadence" \
  io.hass.description="Touch-friendly calendar for Home Assistant" \
  io.hass.type="app" \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.arch="aarch64|amd64"

EXPOSE 8099
CMD ["/run.sh"]
