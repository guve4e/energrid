#!/usr/bin/env python3

import argparse
import json
import math
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeHttpDeviceHandler(BaseHTTPRequestHandler):
    started_at = time.time()
    base_temperature = 22.4
    base_humidity = 48.0
    base_power = 420.0

    def do_GET(self):
        if self.path not in ["/", "/status", "/state"]:
            self.send_response(404)
            self.end_headers()
            return

        elapsed = time.time() - self.started_at
        wave = math.sin(elapsed / 12)
        payload = {
            "deviceId": self.server.device_id,
            "name": self.server.device_name,
            "values": {
                "temperature": round(self.base_temperature + wave * 0.9 + random.uniform(-0.05, 0.05), 2),
                "humidity": round(self.base_humidity + wave * 1.8 + random.uniform(-0.2, 0.2), 1),
                "power": round(max(0, self.base_power + wave * 80 + random.uniform(-8, 8)), 1),
            },
            "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"[fake-http-device] {self.address_string()} {format % args}")


def main():
    parser = argparse.ArgumentParser(description="Serve a fake HTTP device with changing sensor values.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8088)
    parser.add_argument("--device-id", default="kitchen.temperature.http")
    parser.add_argument("--name", default="Kitchen temperature HTTP sensor")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), FakeHttpDeviceHandler)
    server.device_id = args.device_id
    server.device_name = args.name

    print(f"[fake-http-device] http://{args.host}:{args.port}/status")
    server.serve_forever()


if __name__ == "__main__":
    main()
