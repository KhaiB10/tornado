#!/usr/bin/env bash
# Runs your agent command with Tornado injecting faults in front of the model.
# Self-contained: tornado is pure Node (no deps), run straight from this repo.
set -uo pipefail

PORT="${TORNADO_PORT:-8100}"
SEED_ARG=""
[ -n "${TORNADO_SEED:-}" ] && SEED_ARG="--seed ${TORNADO_SEED}"

echo "Starting Tornado on :${PORT} -> ${TORNADO_UPSTREAM}"
echo "Faults: ${TORNADO_FAULTS}"
# shellcheck disable=SC2086
node "${TORNADO_BIN}" --upstream "${TORNADO_UPSTREAM}" --port "${PORT}" ${SEED_ARG} ${TORNADO_FAULTS} > /tmp/tornado.log 2>&1 &
TPID=$!

# Wait for the proxy to accept connections (max ~10s).
up=0
for _ in $(seq 1 40); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then exec 3>&- 3<&-; up=1; break; fi
  sleep 0.25
done
if [ "$up" != 1 ]; then echo "::error::tornado did not start"; cat /tmp/tornado.log; kill "$TPID" 2>/dev/null; exit 1; fi

export TORNADO_URL="http://127.0.0.1:${PORT}/v1"
export OPENAI_BASE_URL="http://127.0.0.1:${PORT}/v1"
export OPENAI_API_BASE="http://127.0.0.1:${PORT}/v1"

echo "::group::Agent run under injected faults"
bash -c "${TORNADO_COMMAND}"
CODE=$?
echo "::endgroup::"

# Ask tornado to print its report, then stop it.
kill -INT "$TPID" 2>/dev/null
sleep 1
kill "$TPID" 2>/dev/null
echo "::group::Tornado injection report"
cat /tmp/tornado.log
echo "::endgroup::"

if [ "$CODE" -eq 0 ]; then
  echo "✅ Agent survived the injected faults (command exited 0)."
else
  echo "::error::Agent failed under injected faults (command exited ${CODE}). Your agent isn't resilient to these model failures."
fi
exit "$CODE"
