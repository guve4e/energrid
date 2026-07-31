#!/usr/bin/env python3
import os
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: local-whisper-transcribe.py <audio.wav>", file=sys.stderr)
        return 2

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(
            "Missing faster-whisper. Install it with: pip install faster-whisper",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 3

    audio_path = sys.argv[1]
    model_name = os.environ.get("LOCAL_WHISPER_MODEL_PATH") or os.environ.get(
        "LOCAL_WHISPER_MODEL", "small"
    )
    device = os.environ.get("LOCAL_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("LOCAL_WHISPER_COMPUTE_TYPE", "int8")
    language = os.environ.get("LOCAL_WHISPER_LANGUAGE", "bg")

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, _info = model.transcribe(
        audio_path,
        language=language,
        beam_size=int(os.environ.get("LOCAL_WHISPER_BEAM_SIZE", "1")),
        vad_filter=False,
    )

    text = " ".join(segment.text.strip() for segment in segments).strip()
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
