#!/usr/bin/env python3
"""Small authenticated LAN ingestion service for Energrid research audio."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import io
import json
import logging
import os
import re
import shutil
import socket
import threading
import wave
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

LOG = logging.getLogger("energrid_audio_ingest")
MAX_METADATA_BYTES = 16_384
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Store:
    def __init__(self, root: Path, quota_bytes: int, min_free_bytes: int):
        self.root = root.resolve()
        self.quota_bytes = quota_bytes
        self.min_free_bytes = min_free_bytes
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "sessions").mkdir(exist_ok=True)
        self.lock = threading.RLock()

    def used_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())

    def index(self) -> Path:
        return self.root / "index.jsonl"

    def write_session_manifest(self, device_id: str, session_id: str, rows: list[dict]) -> None:
        if not SAFE_ID.fullmatch(device_id) or not SAFE_ID.fullmatch(session_id):
            return
        path = self.root / "sessions" / device_id / session_id / "session.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".jsonl.tmp")
        with temp.open("w", encoding="utf-8") as out:
            for row in rows:
                if row.get("device_id") == device_id and row.get("session_id") == session_id:
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
        sync_directory(path.parent)

    def existing_hash(self, digest: str) -> dict | None:
        for row in self.iter_rows():
            if row.get("sha256") == digest:
                return row
        return None

    def existing_clip(self, clip_id: str) -> dict | None:
        for row in self.iter_rows():
            if row.get("clip_id") == clip_id:
                return row
        return None

    def iter_rows(self):
        path = self.index()
        if not path.exists():
            return
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    LOG.warning("Ignoring malformed index row")

    def receive(self, metadata: dict, body: bytes, digest: str, reserved_bytes: int = 0) -> tuple[dict, bool]:
        required = ("clip_id", "session_id", "device_id", "category", "started_at")
        if any(not isinstance(metadata.get(key), str) or not metadata[key] for key in required):
            raise ValueError("missing required metadata")
        for key in ("clip_id", "session_id", "device_id"):
            if not SAFE_ID.fullmatch(metadata[key]):
                raise ValueError(f"invalid {key}")
        if not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            raise ValueError("invalid SHA-256")
        actual = hashlib.sha256(body).hexdigest()
        if not hmac.compare_digest(actual.lower(), digest.lower()):
            raise ValueError("SHA-256 mismatch")
        try:
            with wave.open(io.BytesIO(body), "rb") as audio:
                if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getcomptype()) != (16000, 1, 2, "NONE"):
                    raise ValueError("audio must be uncompressed 16 kHz mono PCM16 WAV")
                duration = audio.getnframes() / audio.getframerate()
        except (wave.Error, EOFError) as error:
            raise ValueError("invalid WAV payload") from error
        if metadata.get("sample_rate", 16000) != 16000 or metadata.get("channels", 1) != 1:
            raise ValueError("metadata audio format does not match the PCM16 WAV")
        if metadata.get("duration_seconds") is not None and abs(float(metadata["duration_seconds"]) - duration) > 0.08:
            raise ValueError("metadata duration does not match WAV frames")
        category = re.sub(r"[^A-Za-z0-9_-]", "_", metadata["category"])[:64] or "unknown"
        date = re.sub(r"[^0-9-]", "", metadata["started_at"][:10]) or "unknown-date"
        session = metadata["session_id"]
        clip_id = metadata["clip_id"]
        relative = Path("sessions") / metadata["device_id"] / session / date / category / f"{clip_id}.wav"
        target = (self.root / relative).resolve()
        if self.root not in target.parents:
            raise ValueError("invalid storage path")
        with self.lock:
            same_clip = self.existing_clip(clip_id)
            if same_clip:
                if same_clip.get("sha256") != actual or same_clip.get("bytes") != len(body):
                    raise ValueError("clip id already exists with different audio")
                return {"clip_id": clip_id, "sha256": actual, "bytes": len(body),
                        "path": same_clip["path"]}, True
            duplicate = self.existing_hash(actual)
            if duplicate:
                return {"clip_id": duplicate["clip_id"], "sha256": actual,
                        "bytes": duplicate.get("bytes", len(body)), "path": duplicate["path"]}, True
            disk_free = shutil.disk_usage(self.root).free
            if self.used_bytes() - reserved_bytes + len(body) > self.quota_bytes or disk_free - len(body) < self.min_free_bytes:
                raise OSError("storage quota exceeded")
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix(".wav.uploading")
            with temp.open("wb") as out:
                out.write(body)
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, target)
            sync_directory(target.parent)
            row = dict(metadata)
            row.update({"sha256": actual, "bytes": len(body), "path": str(relative),
                        "duration_seconds": duration, "received_at": utc_now(),
                        "label": "unlabeled", "label_source": "none"})
            with self.index().open("a", encoding="utf-8") as out:
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.flush()
                os.fsync(out.fileno())
            sync_directory(self.root)
            self.write_session_manifest(row["device_id"], row["session_id"], [*list(self.iter_rows() or []), row])
            return {"clip_id": clip_id, "sha256": actual, "path": str(relative)}, False

    def label(self, clip_id: str, label: str, occurrences: list | None = None) -> dict:
        if label not in {"confirmed_positive", "confirmed_negative", "uncertain", "unlabeled"}:
            raise ValueError("invalid label")
        with self.lock:
            rows = list(self.iter_rows() or [])
            match = next((row for row in rows if row.get("clip_id") == clip_id), None)
            if not match:
                raise FileNotFoundError(clip_id)
            if occurrences is not None:
                if not isinstance(occurrences, list):
                    raise ValueError("wake-word occurrences must be a list of seconds")
                duration = float(match.get("duration_seconds", 0))
                clean = []
                for item in occurrences:
                    value = float(item)
                    if not (0 <= value <= duration) or value != value or value in clean:
                        raise ValueError("wake-word occurrence is outside the clip or duplicated")
                    clean.append(value)
                occurrences = sorted(clean)
            match["label"] = label
            match["label_source"] = "human_review"
            match["reviewed_at"] = utc_now()
            if occurrences is not None:
                match["wake_word_occurrences"] = occurrences
            tmp = self.index().with_suffix(".jsonl.tmp")
            with tmp.open("w", encoding="utf-8") as out:
                for row in rows:
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
            os.replace(tmp, self.index())
            self.write_session_manifest(match["device_id"], match["session_id"], rows)
            return match

    def delete(self, clip_id: str) -> bool:
        with self.lock:
            rows = list(self.iter_rows() or [])
            match = next((row for row in rows if row.get("clip_id") == clip_id), None)
            if not match:
                return False
            (self.root / match["path"]).unlink(missing_ok=True)
            tmp = self.index().with_suffix(".jsonl.tmp")
            with tmp.open("w", encoding="utf-8") as out:
                for row in rows:
                    if row.get("clip_id") != clip_id:
                        out.write(json.dumps(row, ensure_ascii=False) + "\n")
            os.replace(tmp, self.index())
            self.write_session_manifest(match["device_id"], match["session_id"], [row for row in rows if row.get("clip_id") != clip_id])
            return True


class Handler(BaseHTTPRequestHandler):
    server_version = "EnergridAudio/1"

    @property
    def store(self) -> Store:
        return self.server.store  # type: ignore[attr-defined]

    def authorized(self) -> bool:
        value = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.token  # type: ignore[attr-defined]
        if hmac.compare_digest(value, expected):
            return True
        self.send_json(401, {"error": "unauthorized"})
        return False

    def send_json(self, status: int, value: dict | list):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def handle_one_request(self):
        try:
            initial = self.connection.recv(2, socket.MSG_PEEK)
        except OSError:
            initial = b""
        if initial.startswith(b"\x16"):
            self.close_connection = True
            LOG.warning(json.dumps({"event": "tls_to_http", "client": self.address_string(),
                                    "message": "TLS handshake received by HTTP-only listener; use http://"}))
            return
        super().handle_one_request()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            page = Path(__file__).with_name("review.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)
            return
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "used_bytes": self.store.used_bytes(),
                                 "quota_bytes": self.store.quota_bytes,
                                 "disk_free_bytes": shutil.disk_usage(self.store.root).free,
                                 "min_free_bytes": self.store.min_free_bytes, "time": utc_now()})
            return
        if not self.authorized():
            return
        upload_prefix = "/v1/uploads/"
        if parsed.path.startswith(upload_prefix):
            clip_id = unquote(parsed.path[len(upload_prefix):])
            if not SAFE_ID.fullmatch(clip_id):
                self.send_json(400, {"error": "invalid clip id"})
                return
            row = next((x for x in self.store.iter_rows() or [] if x.get("clip_id") == clip_id), None)
            part = self.store.root / ".uploads" / f"{clip_id}.part"
            self.send_json(200, {
                "complete": bool(row),
                "next_offset": row.get("bytes", 0) if row else (part.stat().st_size if part.exists() else 0),
                "bytes": row.get("bytes") if row else None,
                "sha256": row.get("sha256") if row else None,
            })
            return
        if parsed.path == "/v1/segments":
            rows = list(self.store.iter_rows() or [])
            self.send_json(200, {"segments": rows, "counts": {
                label: sum(row.get("label") == label for row in rows)
                for label in ("confirmed_positive", "confirmed_negative", "uncertain", "unlabeled")
            }, "used_bytes": self.store.used_bytes(), "quota_bytes": self.store.quota_bytes})
            return
        prefix = "/v1/audio/"
        if parsed.path.startswith(prefix):
            clip_id = unquote(parsed.path[len(prefix):])
            row = next((x for x in self.store.iter_rows() or [] if x.get("clip_id") == clip_id), None)
            if not row:
                self.send_json(404, {"error": "not found"})
                return
            audio_path = self.store.root / row["path"]
            size = audio_path.stat().st_size
            start, end = 0, size - 1
            partial = False
            range_header = self.headers.get("Range", "")
            if range_header:
                try:
                    if not range_header.startswith("bytes=") or "," in range_header:
                        raise ValueError("unsupported byte range")
                    first, last = range_header[6:].split("-", 1)
                    if first:
                        start = int(first)
                        end = int(last) if last else size - 1
                    else:
                        suffix_length = int(last)
                        if suffix_length <= 0:
                            raise ValueError("invalid suffix range")
                        start = max(0, size - suffix_length)
                    if start < 0 or start >= size or end < start:
                        raise ValueError("unsatisfiable byte range")
                    end = min(end, size - 1)
                    partial = True
                except (ValueError, TypeError):
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            length = end - start + 1
            self.send_response(206 if partial else 200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            if partial:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            with audio_path.open("rb") as audio:
                audio.seek(start)
                remaining = length
                while remaining:
                    chunk = audio.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/v1/segments":
            try:
                size = int(self.headers.get("Content-Length", "-1"))
                if size < 44 or size > 64 * 1024 * 1024:
                    raise ValueError("invalid payload size")
                meta_len = int(self.headers.get("X-Metadata-Length", "0"))
                if not 1 <= meta_len <= MAX_METADATA_BYTES:
                    raise ValueError("invalid metadata length")
                metadata = json.loads(self.headers.get("X-Segment-Metadata", "{}"))
                body = self.rfile.read(size)
                result, duplicate = self.store.receive(metadata, body, self.headers.get("X-SHA256", ""))
                self.send_json(200 if duplicate else 201, {"acknowledged": True, "duplicate": duplicate, **result})
            except (ValueError, OSError, json.JSONDecodeError) as error:
                status = 507 if "quota" in str(error) else 400
                self.send_json(status, {"error": str(error)})
            return
        prefix = "/v1/labels/"
        if parsed.path.startswith(prefix):
            try:
                clip_id = unquote(parsed.path[len(prefix):])
                data = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", "0")), MAX_METADATA_BYTES)))
                row = self.store.label(clip_id, data.get("label", ""), data.get("wake_word_occurrences"))
                self.send_json(200, {"updated": True, "clip_id": clip_id, "label": row["label"]})
            except FileNotFoundError:
                self.send_json(404, {"error": "not found"})
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)})
            return
        self.send_json(404, {"error": "not found"})

    def do_PUT(self):
        if not self.authorized():
            return
        prefix = "/v1/uploads/"
        if not self.path.startswith(prefix):
            self.send_json(404, {"error": "not found"})
            return
        clip_id = unquote(self.path[len(prefix):])
        range_match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", self.headers.get("Content-Range", ""))
        try:
            if not SAFE_ID.fullmatch(clip_id) or not range_match:
                raise ValueError("invalid upload id or content range")
            start, end, total = map(int, range_match.groups())
            content_length = int(self.headers.get("Content-Length", "-1"))
            if total < 44 or total > 64 * 1024 * 1024 or end < start or end - start + 1 != content_length:
                raise ValueError("invalid chunk size")
            metadata = json.loads(self.headers.get("X-Segment-Metadata", "{}"))
            if metadata.get("clip_id") != clip_id or not re.fullmatch(r"[a-fA-F0-9]{64}", self.headers.get("X-SHA256", "")):
                raise ValueError("metadata does not match upload")
            body = self.rfile.read(content_length)
            if len(body) != content_length:
                raise ValueError("truncated chunk")
            upload_dir = self.store.root / ".uploads"
            upload_dir.mkdir(exist_ok=True)
            part = upload_dir / f"{clip_id}.part"
            with self.store.lock:
                current = part.stat().st_size if part.exists() else 0
                if start < current and end < current:
                    self.send_json(308, {"complete": False, "next_offset": current})
                    return
                if start != current:
                    self.send_json(409, {"complete": False, "next_offset": current})
                    return
                disk_free = shutil.disk_usage(self.store.root).free
                if self.store.used_bytes() + content_length > self.store.quota_bytes or disk_free - content_length < self.store.min_free_bytes:
                    self.send_json(507, {"error": "storage quota exceeded"})
                    return
                with part.open("ab") as out:
                    out.write(body)
                    out.flush()
                    os.fsync(out.fileno())
                next_offset = part.stat().st_size
                if next_offset < total:
                    self.send_json(308, {"complete": False, "next_offset": next_offset})
                    return
                if next_offset != total:
                    raise ValueError("uploaded size exceeds declared total")
                payload = part.read_bytes()
                result, duplicate = self.store.receive(metadata, payload, self.headers.get("X-SHA256", ""), reserved_bytes=next_offset)
                part.unlink(missing_ok=True)
            self.send_json(200 if duplicate else 201, {"acknowledged": True, "complete": True, "duplicate": duplicate, **result})
        except (ValueError, OSError, json.JSONDecodeError) as error:
            status = 507 if "quota" in str(error) else 400
            self.send_json(status, {"error": str(error)})

    def do_DELETE(self):
        if not self.authorized():
            return
        prefix = "/v1/segments/"
        if self.path.startswith(prefix):
            clip_id = unquote(self.path[len(prefix):])
            deleted = self.store.delete(clip_id)
            self.send_json(200 if deleted else 404, {"deleted": deleted})
            return
        self.send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        LOG.info(json.dumps({"event": "http_access", "client": self.address_string(),
                             "message": fmt % args, "timestamp": utc_now()}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("ENERGRID_INGEST_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ENERGRID_INGEST_PORT", "8765")))
    parser.add_argument("--storage", type=Path, default=Path(os.environ.get("ENERGRID_INGEST_STORAGE", "./energrid-audio")))
    parser.add_argument("--quota-gb", type=float, default=float(os.environ.get("ENERGRID_INGEST_QUOTA_GB", "20")))
    parser.add_argument("--min-free-mb", type=float, default=float(os.environ.get("ENERGRID_INGEST_MIN_FREE_MB", "512")))
    parser.add_argument("--token", default=os.environ.get("ENERGRID_INGEST_TOKEN"))
    args = parser.parse_args()
    if not args.token or len(args.token) < 24:
        parser.error("set ENERGRID_INGEST_TOKEN to a random secret of at least 24 characters")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    ip = ipaddress.ip_address(args.host)
    if not (ip.is_private or ip.is_loopback) or ip.is_unspecified or ip.is_multicast:
        parser.error("host must be a private LAN interface address; wildcard and public interfaces are not allowed")
    server.store = Store(args.storage, int(args.quota_gb * 1024**3), int(args.min_free_mb * 1024**2))  # type: ignore[attr-defined]
    server.token = args.token  # type: ignore[attr-defined]
    LOG.info(json.dumps({"event": "server_started", "host": args.host, "port": args.port,
                         "storage": str(args.storage), "quota_bytes": server.store.quota_bytes,
                         "timestamp": utc_now()}))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    main()
