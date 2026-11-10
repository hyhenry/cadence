#!/bin/sh
# Started by the Supervisor. SUPERVISOR_TOKEN is provided automatically
# (homeassistant_api: true), so there is nothing to configure.
set -e
if [ -z "${SUPERVISOR_TOKEN}" ]; then
  echo "[cadence] SUPERVISOR_TOKEN is not set; is homeassistant_api enabled?" >&2
fi
export CADENCE_DATA_DIR=/data
exec node --disable-warning=ExperimentalWarning /app/server/dist/main.js
