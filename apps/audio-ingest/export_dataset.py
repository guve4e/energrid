#!/usr/bin/env python3
"""Export human-reviewed recordings with session-grouped splits."""

import argparse
import hashlib
import json
import random
import shutil
import wave
from pathlib import Path

LABELS = {"confirmed_positive", "confirmed_negative"}
POSITIVE_WINDOW_BEFORE_SECONDS = 0.75
POSITIVE_WINDOW_AFTER_SECONDS = 1.75


def load_rows(root: Path):
    index = root / "index.jsonl"
    if not index.exists():
        raise SystemExit(f"No ingestion index at {index}")
    for line in index.read_text(encoding="utf-8").splitlines():
        if line.strip():
            yield json.loads(line)


def validate(path: Path, row: dict):
    with wave.open(str(path), "rb") as audio:
        if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError(f"unsupported WAV format: {path}")
        actual_duration = audio.getnframes() / audio.getframerate()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != row.get("sha256"):
        raise ValueError(f"SHA-256 mismatch: {path}")
    return actual_duration


def write_positive_windows(source: Path, target_dir: Path, row: dict) -> list[dict]:
    occurrences = row.get("wake_word_occurrences", [])
    if row.get("label") != "confirmed_positive" or not occurrences:
        return []
    with wave.open(str(source), "rb") as audio:
        rate = audio.getframerate()
        frame_count = audio.getnframes()
        frames = audio.readframes(frame_count)
    window_frames = round((POSITIVE_WINDOW_BEFORE_SECONDS + POSITIVE_WINDOW_AFTER_SECONDS) * rate)
    output = []
    target_dir.mkdir(parents=True, exist_ok=True)
    for index, occurrence in enumerate(occurrences, 1):
        center = round(float(occurrence) * rate)
        start = max(0, center - round(POSITIVE_WINDOW_BEFORE_SECONDS * rate))
        end = min(frame_count, start + window_frames)
        start = max(0, end - window_frames)
        clip_frames = frames[start * 2:end * 2]
        expected_bytes = window_frames * 2
        if len(clip_frames) < expected_bytes:
            clip_frames += b"\x00" * (expected_bytes - len(clip_frames))
        stem = f"{row['clip_id']}_occ_{index:03d}"
        wav_path = target_dir / f"{stem}.wav"
        with wave.open(str(wav_path), "wb") as output_wav:
            output_wav.setnchannels(1)
            output_wav.setsampwidth(2)
            output_wav.setframerate(rate)
            output_wav.writeframes(clip_frames)
        metadata = {k: v for k, v in row.items() if not k.startswith("_")}
        metadata.update({"parent_clip_id": row["clip_id"], "occurrence_seconds": float(occurrence),
                         "duration_seconds": window_frames / rate, "export_path": wav_path.name,
                         "source_sha256": row["sha256"]})
        wav_path.with_suffix(".json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        output.append(metadata)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("storage", type=Path, help="server storage directory")
    parser.add_argument("output", type=Path, help="new, empty export directory")
    parser.add_argument("--test-session", action="append", required=True,
                        help="session ID reserved only for test; repeat for multiple sessions")
    parser.add_argument("--clip-id", action="append",
                        help="include a reviewed clip; repeat to export a selected subset")
    parser.add_argument("--validation-ratio", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=20261017)
    args = parser.parse_args()
    if not 0.05 <= args.validation_ratio <= 0.4:
        parser.error("validation ratio must be between 0.05 and 0.4")
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("output directory must be empty; existing data will not be overwritten")

    rows = [row for row in load_rows(args.storage) if row.get("label") in LABELS and row.get("label_source") == "human_review"]
    if args.clip_id:
        selected = set(args.clip_id)
        missing = selected - {row.get("clip_id") for row in rows}
        if missing:
            raise SystemExit(f"clip(s) not found with a confirmed human label: {', '.join(sorted(missing))}")
        rows = [row for row in rows if row.get("clip_id") in selected]
    unique, seen = [], set()
    for row in rows:
        digest = row.get("sha256")
        if not digest or digest in seen:
            continue
        source = (args.storage / row["path"]).resolve()
        if args.storage.resolve() not in source.parents or not source.is_file():
            raise SystemExit(f"invalid or missing stored path: {row.get('path')}")
        duration = validate(source, row)
        row = dict(row, _source=str(source), _verified_duration_seconds=duration)
        unique.append(row)
        seen.add(digest)

    grouped = {}
    for row in unique:
        grouped.setdefault(row["session_id"], []).append(row)
    test_sessions = set(args.test_session)
    if not test_sessions <= set(grouped):
        raise SystemExit(f"unknown or unlabeled test session(s): {', '.join(sorted(test_sessions - set(grouped)))}")
    remaining = sorted(set(grouped) - test_sessions)
    if len(remaining) < 2:
        raise SystemExit("need at least two non-test sessions for separate train and validation data")
    random.Random(args.seed).shuffle(remaining)
    val_count = max(1, round(len(remaining) * args.validation_ratio))
    val_count = min(val_count, len(remaining) - 1)
    assignment = {session: "test" for session in test_sessions}
    assignment.update({session: "validation" for session in remaining[:val_count]})
    assignment.update({session: "train" for session in remaining[val_count:]})

    args.output.mkdir(parents=True, exist_ok=True)
    manifest = []
    excluded_positive_without_occurrence = 0
    for session, clips in grouped.items():
        split = assignment[session]
        for row in clips:
            if row["label"] == "confirmed_positive":
                relative_dir = Path(split) / "confirmed_positive"
                windows = write_positive_windows(row["_source"], args.output / relative_dir, row)
                if not windows:
                    excluded_positive_without_occurrence += 1
                    continue
                for exported in windows:
                    exported["split"] = split
                    exported["export_path"] = (relative_dir / exported["export_path"]).as_posix()
                    manifest.append(exported)
                continue
            relative = Path(split) / row["label"] / f"{row['clip_id']}.wav"
            target = args.output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(row["_source"], target)
            exported = {k: v for k, v in row.items() if not k.startswith("_")}
            exported.update({"split": split, "export_path": relative.as_posix(),
                             "duration_seconds": row["_verified_duration_seconds"]})
            target.with_suffix(".json").write_text(json.dumps(exported, ensure_ascii=False, indent=2), encoding="utf-8")
            manifest.append(exported)

    (args.output / "manifest.json").write_text(json.dumps({
        "protocol": "session grouped; only human-reviewed confirmed labels; explicitly reserved test sessions",
        "positive_window_seconds": POSITIVE_WINDOW_BEFORE_SECONDS + POSITIVE_WINDOW_AFTER_SECONDS,
        "positive_window_policy": "reviewed wake-word occurrences only; 0.75s before and 1.75s after each timestamp",
        "seed": args.seed,
        "test_sessions": sorted(test_sessions),
        "session_splits": assignment,
        "clips": manifest,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "clips": len(manifest),
        "sessions": {split: sum(value == split for value in assignment.values()) for split in ("train", "validation", "test")},
        "clips_by_split": {split: sum(row["split"] == split for row in manifest) for split in ("train", "validation", "test")},
        "positive_clips_without_occurrence_excluded": excluded_positive_without_occurrence,
        "output": str(args.output),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
