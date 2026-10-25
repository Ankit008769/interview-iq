# Model sidecar for Cloud Run: Ollama with the interview model baked in, so an instance starts without
# downloading weights. The app container in the same instance reaches it at http://127.0.0.1:11434
# (AI_PROVIDER=local). It binds all interfaces because Cloud Run's startup probe cannot reach a server bound to
# loopback; sidecar ports are not exposed outside the instance (only the app container receives requests).
# Same Ollama version as development (docs/LOCAL_MODELS.md).
FROM ollama/ollama:0.40.11@sha256:459985308d740b99071719baec2740a60f5b2b2d9b835c171991ae25690203da

ARG MODEL=qwen3.5:4b
ENV OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_MODELS=/models \
    OLLAMA_CONTEXT_LENGTH=16384 \
    OLLAMA_KEEP_ALIVE=-1 \
    OLLAMA_NUM_PARALLEL=1 \
    INTERVIEW_MODEL=${MODEL}

RUN ollama serve > /tmp/serve.log 2>&1 & pid=$!; \
    for i in $(seq 1 60); do ollama list > /dev/null 2>&1 && break; sleep 1; done; \
    ollama pull "${MODEL}" && ollama list && kill "$pid"

COPY start.sh /start.sh
RUN chmod 0755 /start.sh
ENTRYPOINT ["/start.sh"]
