# Speech-to-text sidecar for Cloud Run: faster-whisper with the model baked in, served by deploy/whisper/server.py.
# The app container reaches it at http://127.0.0.1:8000/v1 (TRANSCRIPTION_BASE_URL). It binds all interfaces so
# Cloud Run's startup probe can reach it; sidecar ports are not exposed outside the instance.
FROM python:3.12-slim

ARG WHISPER_MODEL=small
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    WHISPER_MODEL=${WHISPER_MODEL} WHISPER_MODELS_DIR=/models

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8', download_root='/models')"
# Weights are baked in; never reach out at runtime.
ENV HF_HUB_OFFLINE=1
COPY server.py .

USER nobody
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
