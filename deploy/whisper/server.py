"""OpenAI-compatible speech-to-text for Interview IQ, using faster-whisper on CPU.

POST /v1/audio/transcriptions  multipart: file, model (ignored), optional language  ->  {"text": "..."}
GET  /health                   ->  {"ok": true, "model": "small"}

Audio is decoded in memory; it is never written to disk or logged. Run next to the app on loopback
(development) or as a Cloud Run sidecar. See docs/VOICE_ANSWERS.md.
"""
import io
import os
import re

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
MAX_BYTES = 8 * 1024 * 1024  # same limit as the app's upload route

whisper = WhisperModel(MODEL, device="cpu", compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
                       cpu_threads=int(os.environ.get("WHISPER_THREADS", "0")),
                       download_root=os.environ.get("WHISPER_MODELS_DIR") or None)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


# Sync handler: FastAPI runs it in a worker thread, so CPU-bound decoding does not block other requests.
@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...), model: str | None = Form(None), language: str | None = Form(None)):
    audio = file.file.read(MAX_BYTES + 1)
    if not audio:
        raise HTTPException(400, "Empty recording.")
    if len(audio) > MAX_BYTES:
        raise HTTPException(413, "Recording too large.")
    if language is not None and not re.fullmatch(r"[a-z]{2}", language):
        raise HTTPException(400, "language must be an ISO 639-1 code.")
    try:
        segments, _ = whisper.transcribe(io.BytesIO(audio), language=language, vad_filter=True,
                                         beam_size=int(os.environ.get("WHISPER_BEAM", "1")))
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception:  # unreadable audio; never echo its content
        raise HTTPException(400, "The recording could not be decoded.") from None
    return {"text": text}
