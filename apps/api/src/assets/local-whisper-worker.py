#!/usr/bin/env python3
import json
import os
import sys
import time


def write_json(payload) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def write_stderr(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def main() -> int:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        write_stderr("Missing faster-whisper. Install it with: pip install faster-whisper")
        write_stderr(str(exc))
        return 3

    model_name = os.environ.get("LOCAL_WHISPER_MODEL_PATH") or os.environ.get(
        "LOCAL_WHISPER_MODEL", "small"
    )
    device = os.environ.get("LOCAL_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
    language = os.environ.get("LOCAL_WHISPER_LANGUAGE", "bg")
    beam_size = int(os.environ.get("LOCAL_WHISPER_BEAM_SIZE", "1"))

    started_at = time.time()
    write_stderr(
        f"loading model={model_name} device={device} compute={compute_type} language={language}"
    )
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    write_json(
        {
            "type": "ready",
            "text": str(model_name),
            "durationMs": int((time.time() - started_at) * 1000),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_started_at = time.time()

        try:
            request = json.loads(line)
            request_id = request["id"]
            audio_path = request["audioPath"]

            segments, _info = model.transcribe(
                audio_path,
                language=language,
                beam_size=beam_size,
                vad_filter=False,
            )

            text = " ".join(segment.text.strip() for segment in segments).strip()
            write_json(
                {
                    "id": request_id,
                    "text": text,
                    "durationMs": int((time.time() - request_started_at) * 1000),
                }
            )
        except Exception as exc:
            request_id = None
            try:
                request_id = json.loads(line).get("id")
            except Exception:
                pass

            write_json(
                {
                    "id": request_id,
                    "error": str(exc),
                    "durationMs": int((time.time() - request_started_at) * 1000),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
