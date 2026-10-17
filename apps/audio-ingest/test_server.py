import hashlib
import http.client
import importlib.util
import io
import json
import socket
import tempfile
import threading
import unittest
import wave
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("server.py")
spec = importlib.util.spec_from_file_location("audio_ingest_server", MODULE_PATH)
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


def sample_wav(seconds=1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x01\x00" * (16000 * seconds))
    return buffer.getvalue()


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.http = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.Handler)
        self.http.store = server_module.Store(self.root, 100 * 1024 * 1024, 0)
        self.http.token = "test-token-that-is-long-enough-123456"
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.address = self.http.server_address

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.address, timeout=5)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        status = response.status
        connection.close()
        try:
            value = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            value = payload
        return status, value

    def metadata(self, clip_id="clip_1"):
        return {"clip_id": clip_id, "session_id": "session_1", "device_id": "device_1",
                "category": "conversation", "started_at": "2026-10-17T12:00:00Z",
                "label": "unlabeled", "label_source": "none"}

    def auth(self):
        return {"Authorization": "Bearer " + self.http.token}

    def test_requires_authentication(self):
        status, body = self.request("GET", "/v1/segments")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "unauthorized")

    def test_health_is_public_but_audio_data_routes_require_auth(self):
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        status, body = self.request("GET", "/v1/audio/clip_1")
        self.assertEqual(status, 401)
        status, body = self.request("DELETE", "/v1/segments/clip_1")
        self.assertEqual(status, 401)
        status, body = self.request("POST", "/v1/segments", b"audio")
        self.assertEqual(status, 401)
        status, body = self.request("PUT", "/v1/uploads/clip_1", b"chunk")
        self.assertEqual(status, 401)

    def test_tls_handshake_is_logged_as_https_to_http_mismatch(self):
        with self.assertLogs(server_module.LOG, level="WARNING") as captured:
            with socket.create_connection(self.address, timeout=3) as connection:
                connection.settimeout(3)
                connection.sendall(b"\x16\x03\x01\x00\x10\x01\x00\x00\x0c\x03\x03")
                try:
                    response = connection.recv(1024)
                except ConnectionResetError:
                    response = b""
                self.assertEqual(response, b"")
        self.assertTrue(any('"event": "tls_to_http"' in line for line in captured.output))

    def test_chunked_upload_resumes_and_preserves_original_bytes(self):
        audio = sample_wav()
        digest = hashlib.sha256(audio).hexdigest()
        metadata = self.metadata()
        url = "/v1/uploads/clip_1"
        first = audio[:777]
        headers = {**self.auth(), "Content-Type": "application/octet-stream", "Content-Range": f"bytes 0-{len(first)-1}/{len(audio)}",
                   "X-Segment-Metadata": json.dumps(metadata), "X-SHA256": digest}
        status, result = self.request("PUT", url, first, headers)
        self.assertEqual(status, 308)
        self.assertEqual(result["next_offset"], len(first))
        status, result = self.request("GET", url, headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(result["next_offset"], len(first))
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)
        self.http = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.Handler)
        self.http.store = server_module.Store(self.root, 100 * 1024 * 1024, 0)
        self.http.token = "test-token-that-is-long-enough-123456"
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.address = self.http.server_address
        status, result = self.request("GET", url, headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(result["next_offset"], len(first))
        remainder = audio[len(first):]
        headers["Content-Range"] = f"bytes {len(first)}-{len(audio)-1}/{len(audio)}"
        status, result = self.request("PUT", url, remainder, headers)
        self.assertEqual(status, 201)
        self.assertTrue(result["acknowledged"])
        stored = self.root / result["path"]
        self.assertEqual(stored.read_bytes(), audio)
        status, result = self.request("GET", url, headers=self.auth())
        self.assertTrue(result["complete"])

    def test_duplicate_hash_is_idempotent_and_review_delete_updates_index(self):
        audio = sample_wav()
        digest = hashlib.sha256(audio).hexdigest()
        metadata = self.metadata()
        status, first = self.request("POST", "/v1/segments", audio, {
            **self.auth(), "Content-Type": "audio/wav", "Content-Length": str(len(audio)),
            "X-Segment-Metadata": json.dumps(metadata), "X-Metadata-Length": str(len(json.dumps(metadata))), "X-SHA256": digest,
        })
        self.assertEqual(status, 201)
        status, duplicate = self.request("POST", "/v1/segments", audio, {
            **self.auth(), "Content-Type": "audio/wav", "Content-Length": str(len(audio)),
            "X-Segment-Metadata": json.dumps(self.metadata("clip_2")), "X-Metadata-Length": str(len(json.dumps(metadata))), "X-SHA256": digest,
        })
        self.assertEqual(status, 200)
        self.assertTrue(duplicate["duplicate"])
        status, result = self.request("POST", "/v1/labels/clip_1", json.dumps({"label": "confirmed_positive", "wake_word_occurrences": [0.5]}),
                                      {**self.auth(), "Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(result["label"], "confirmed_positive")
        status, indexed = self.request("GET", "/v1/segments", headers=self.auth())
        self.assertEqual(indexed["counts"]["confirmed_positive"], 1)
        self.assertEqual(len(indexed["segments"]), 1)
        status, deleted = self.request("DELETE", "/v1/segments/clip_1", headers=self.auth())
        self.assertEqual(status, 200)
        self.assertTrue(deleted["deleted"])
        self.assertFalse((self.root / first["path"]).exists())
        self.assertEqual(list(self.http.store.iter_rows()), [])

    def test_bad_checksum_is_rejected(self):
        audio = sample_wav()
        metadata = self.metadata()
        with self.assertRaises(ValueError):
            self.http.store.receive(metadata, audio, "0" * 64)


if __name__ == "__main__":
    unittest.main()
