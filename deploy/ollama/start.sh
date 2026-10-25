#!/bin/sh
# Starts Ollama, then loads the interview model into memory so the first interview does not wait for it.
# The startup probe (GET /api/version) passes once the server answers; loading continues in the background.
set -eu
/bin/ollama serve &
server=$!
for i in $(seq 1 60); do
  /bin/ollama list > /dev/null 2>&1 && break
  sleep 1
done
/bin/ollama run "${INTERVIEW_MODEL}" "" > /dev/null 2>&1 || echo "Model preload failed; it will load on first request." >&2
wait "$server"
