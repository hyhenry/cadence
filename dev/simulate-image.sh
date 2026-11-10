#!/bin/sh
# Mirrors cadence/Dockerfile without Docker: clean install + build, server-only
# production dependencies, the /app runtime layout, then a smoke test of that
# layout against dev/mock-ha. Use when no container runtime is available.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill $MOCK_PID $APP_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT
MOCK_PID=""; APP_PID=""

echo "== lockfile has Linux musl native bindings (the Supervisor builds on Alpine)"
for pkg in @rolldown/binding-linux-arm64-musl @rolldown/binding-linux-x64-musl lightningcss-linux-arm64-musl lightningcss-linux-x64-musl; do
  grep -q "\"node_modules/$pkg\"" "$ROOT/cadence/package-lock.json" || { echo "missing $pkg in cadence/package-lock.json" >&2; exit 1; }
done

echo "== build stage"
mkdir -p "$WORK/build"
( cd "$ROOT/cadence" && tar --exclude='node_modules' --exclude='dist' --exclude='server/test' --exclude='*.test.ts' -cf - . ) | tar -xf - -C "$WORK/build"
( cd "$WORK/build" && npm ci --no-audit --no-fund --silent && npm run build --silent )

echo "== deps stage"
mkdir -p "$WORK/deps/server" "$WORK/deps/web"
cp "$ROOT/cadence/package.json" "$ROOT/cadence/package-lock.json" "$WORK/deps/"
cp "$ROOT/cadence/server/package.json" "$WORK/deps/server/"
cp "$ROOT/cadence/web/package.json" "$WORK/deps/web/"
( cd "$WORK/deps" && npm ci --omit=dev --workspace=server --no-audit --no-fund --silent && mkdir -p server/node_modules )

echo "== runtime layout"
APP="$WORK/app"
mkdir -p "$APP/server" "$APP/web"
cp -R "$WORK/deps/node_modules" "$APP/node_modules"
cp -R "$WORK/deps/server/node_modules" "$APP/server/node_modules"
cp "$WORK/build/server/package.json" "$APP/server/"
cp -R "$WORK/build/server/dist" "$APP/server/dist"
cp -R "$WORK/build/web/dist" "$APP/web/dist"
if [ -d "$APP/node_modules/react" ] || [ -d "$APP/node_modules/vite" ]; then echo "web/dev dependencies leaked into the runtime image" >&2; exit 1; fi
du -sh "$APP" | sed 's/^/runtime size: /'

echo "== smoke test"
MOCK_PORT=8324 node "$ROOT/dev/mock-ha/src/main.ts" >/dev/null 2>&1 & MOCK_PID=$!
sleep 1
( cd / && CADENCE_PORT=8399 MOCK_HA_URL=http://127.0.0.1:8324 CADENCE_DATA_DIR="$WORK/data" CADENCE_ENV_FILE=/nonexistent NODE_ENV=production \
  node --disable-warning=ExperimentalWarning "$APP/server/dist/main.js" >"$WORK/app.log" 2>&1 ) & APP_PID=$!
# Wait until the server is up and its HA websocket is connected.
for i in $(seq 1 30); do curl -sf http://127.0.0.1:8399/api/info 2>/dev/null | grep -q '"connected":true' && break; sleep 0.5; done
curl -sf http://127.0.0.1:8399/api/info | grep -q '"connected":true' || { echo "server did not connect:" >&2; cat "$WORK/app.log" >&2; exit 1; }
curl -sf http://127.0.0.1:8399/ | grep -q 'src="./assets/'
ASSET=$(curl -sf http://127.0.0.1:8399/ | sed -n 's/.*src="\.\/\(assets\/[^"]*\.js\)".*/\1/p' | head -1)
curl -sf "http://127.0.0.1:8399/$ASSET" >/dev/null
curl -sf http://127.0.0.1:8399/api/calendars | grep -q 'calendar.family'
test -f "$WORK/data/cadence.db"
echo "OK: runtime layout serves the web app and API (asset $ASSET)"
