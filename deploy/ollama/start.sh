#!/bin/sh
# Starts Ollama, then loads the interview model into memory so the first interview does not wait for it.
# The startup probe (GET /api/version) passes once the server answers; loading continues in the background.
# OLLAMA_PRELOAD=0 skips it: as a separate scale-to-zero service, CPU is only granted during requests, so the
# app's warm-up request (an empty prompt) loads the model instead.
set -eu
/bin/ollama serve &
server=$!
for i in $(seq 1 60); do
  /bin/ollama list > /dev/null 2>&1 && break
  sleep 1
done
if [ "${OLLAMA_PRELOAD:-1}" != "0" ]; then
  /bin/ollama run "${INTERVIEW_MODEL}" "" > /dev/null 2>&1 || echo "Model preload failed; it will load on first request." >&2
fi
wait "$server"
