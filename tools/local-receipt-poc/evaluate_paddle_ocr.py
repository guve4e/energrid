#!/usr/bin/env python3
"""Run Bulgarian PP-OCRv5 locally and preserve raw evidence outside the repo.

This is an opt-in benchmark utility, not an application runtime dependency.
Install PaddleOCR/PaddlePaddle in an external virtual environment and pass a
receipt image plus an output directory outside the repository.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import time
from pathlib import Path

import psutil


def _plain_json(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "item"):
        return value.item()
    return str(value)


def summarize_raw_result(raw_result: dict) -> dict:
    result = raw_result.get("res", raw_result)
    texts = result.get("rec_texts", [])
    boxes = result.get("rec_boxes", result.get("dt_polys", []))
    scores = result.get("rec_scores", [])
    confidences = [float(score) for score in scores if score is not None]
    return {
        "text_region_count": len(texts),
        "box_count": len(boxes),
        "confidence_count": len(confidences),
        "mean_confidence": round(sum(confidences) / len(confidences), 4) if confidences else None,
        "min_confidence": round(min(confidences), 4) if confidences else None,
        "reading_order": "recognizer output order; raw arrays retain matching indices",
    }


def verify_offline_models(cache_dir: Path) -> None:
    models_dir = cache_dir / "official_models"
    required = ("PP-OCRv5_mobile_det", "cyrillic_PP-OCRv5_mobile_rec")
    for name in required:
        model_dir = models_dir / name
        if not model_dir.is_dir() or not any(path.is_file() for path in model_dir.rglob("*")):
            raise FileNotFoundError(f"Offline PaddleOCR model is not cached: {name}")


def run(image_path: Path, output_dir: Path, cache_dir: Path, cpu_threads: int = 2, offline: bool = False) -> dict:
    if not image_path.is_file():
        raise FileNotFoundError(f"Input image does not exist: {image_path}")
    output_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(cache_dir))
    if offline:
        verify_offline_models(cache_dir)

    from paddleocr import PaddleOCR

    process = psutil.Process()
    rss_before = process.memory_info().rss
    started = time.perf_counter()
    ocr = PaddleOCR(
        lang="bg",
        ocr_version="PP-OCRv5",
        device="cpu",
        cpu_threads=cpu_threads,
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="cyrillic_PP-OCRv5_mobile_rec",
        text_det_limit_side_len=1600,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    loaded = time.perf_counter()
    rss_loaded = process.memory_info().rss
    results = ocr.predict(str(image_path))
    finished = time.perf_counter()
    rss_after = process.memory_info().rss
    raw_path = output_dir / "raw_ocr.json"
    raw_path.write_text(
        json.dumps(results, ensure_ascii=False, indent=2, default=_plain_json),
        encoding="utf-8",
    )
    raw_values = json.loads(raw_path.read_text(encoding="utf-8"))
    summary = summarize_raw_result(raw_values[0]) if raw_values else summarize_raw_result({})
    metrics = {
        "pipeline": "PP-OCRv5",
        "language": "bg",
        "detection_model": "PP-OCRv5_mobile_det",
        "recognition_model": "cyrillic_PP-OCRv5_mobile_rec",
        "device": "cpu",
        "cpu_threads": cpu_threads,
        "paddleocr_version": importlib.metadata.version("paddleocr"),
        "paddlepaddle_version": importlib.metadata.version("paddlepaddle"),
        "input_bytes": image_path.stat().st_size,
        "initialization_seconds": round(loaded - started, 3),
        "inference_seconds": round(finished - loaded, 3),
        "total_seconds": round(finished - started, 3),
        "rss_before_bytes": rss_before,
        "rss_after_model_load_bytes": rss_loaded,
        "rss_after_inference_bytes": rss_after,
        "memory_measurement": "sampled process RSS; not a guaranteed peak",
        "raw_output_path": str(raw_path),
        **summary,
    }
    (output_dir / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="Receipt image or user-created crop")
    parser.add_argument("--output-dir", required=True, type=Path, help="Protected directory outside the repository")
    parser.add_argument("--model-cache", required=True, type=Path, help="PaddleX cache directory outside the repository")
    parser.add_argument("--cpu-threads", type=int, default=2)
    parser.add_argument("--offline", action="store_true", help="Require cached models and prohibit automatic model downloads")
    args = parser.parse_args()
    print(json.dumps(run(args.image, args.output_dir, args.model_cache, args.cpu_threads, args.offline), indent=2))


if __name__ == "__main__":
    main()
