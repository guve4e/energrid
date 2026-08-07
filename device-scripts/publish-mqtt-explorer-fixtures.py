#!/usr/bin/env python3

import argparse
import json
import random
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone


TOPIC_FIXTURES = [
    (
        "devices/esp8266-temp-sensor-new/status",
        {
            "deviceId": "esp8266-temp-sensor-new",
            "name": "ESP8266 Temp Sensor",
            "type": "sensor",
            "firmware": "energrid-legacy-1",
            "location": "garage",
            "temperature": 23.6,
            "humidity": 48.0,
        },
        True,
    ),
    (
        "devices/temp-garage/status",
        {
            "deviceId": "temp-garage",
            "name": "ESP8266 Temp Sensor",
            "type": "sensor",
            "temperature": 31.4,
            "humidity": 56.1,
            "location": "garage",
        },
        True,
    ),
    (
        "devices/temp-kitchen/status",
        {
            "deviceId": "temp-kitchen",
            "name": "ESP8266 Temp Sensor",
            "type": "sensor",
            "temperature": 24.5,
            "humidity": 45.4,
            "location": "kitchen",
        },
        True,
    ),
    (
        "devices/temp-boiler-room/status",
        {
            "deviceId": "temp-boiler-room",
            "name": "ESP8266 Temp Sensor",
            "type": "sensor",
            "temperature": 26.0,
            "humidity": 40.2,
            "location": "boiler-room",
        },
        True,
    ),
    ("shellyplus1-cc7b5c0ea5f8/online", False, True),
    ("shellyplus1-78ee4ccf4b54/online", True, True),
    (
        "shelly/status/shellyplus1-78ee4ccf4b54",
        {
            "id": "shellyplus1-78ee4ccf4b54",
            "model": "SNSW-001X16EU",
            "switch:0": {"id": 0, "output": False, "apower": 0.0},
            "input:0": {"id": 0, "state": False},
            "mqtt": {"connected": True},
            "wifi": {"sta_ip": "192.168.1.135", "rssi": -57},
        },
        True,
    ),
    (
        "shelly/events/shellyplus1-78ee4ccf4b54",
        {
            "src": "shellyplus1-78ee4ccf4b54",
            "method": "NotifyStatus",
            "params": {"switch:0": {"id": 0, "output": False, "apower": 0.0}},
        },
        False,
    ),
    (
        "$SYS/broker/clients/connected",
        7,
        True,
    ),
    (
        "$SYS/broker/messages/received",
        94,
        True,
    ),
]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed Mosquitto with retained topics that make the portal Bus page look like an MQTT explorer."
    )
    parser.add_argument("--host", default="devicebroker.ddns.net")
    parser.add_argument("--port", default="1883")
    parser.add_argument("--username", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--tenant", default="tenant-demo")
    parser.add_argument("--site", default="site-home")
    parser.add_argument("--count", type=int, default=1, help="Telemetry rounds. Use 0 for forever.")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-retain", action="store_true")
    args = parser.parse_args()

    if not args.dry_run and not shutil.which("mosquitto_pub"):
        raise SystemExit("mosquitto_pub not found. Install mosquitto-clients or run with --dry-run.")

    publish_initial_tree(args)

    rounds = 0
    while args.count == 0 or rounds < args.count:
        rounds += 1
        publish_live_round(args, rounds)
        if args.count == 0 or rounds < args.count:
            time.sleep(args.interval)

    return 0


def publish_initial_tree(args):
    for topic, payload, retain in TOPIC_FIXTURES:
        publish(args, topic, payload, retain=retain and not args.no_retain)

    prefix = f"energrid/{topic_part(args.tenant)}/{topic_part(args.site)}"
    publish(
        args,
        f"{prefix}/gateway/{topic_part(args.site)}-gateway/status",
        {
            "tenantId": args.tenant,
            "siteId": args.site,
            "gatewayId": f"{topic_part(args.site)}-gateway",
            "status": "online",
            "observedAt": now_iso(),
            "transport": "mqtt",
        },
        retain=not args.no_retain,
    )
    publish(
        args,
        f"{prefix}/debug/manual",
        {"type": "debug_ping", "source": "fixture", "observedAt": now_iso()},
        retain=not args.no_retain,
    )


def publish_live_round(args, round_number):
    kitchen = round(24.4 + random.uniform(-0.18, 0.18), 2)
    garage = round(31.4 + random.uniform(-0.25, 0.25), 2)
    switch_on = round_number % 2 == 0

    publish(
        args,
        "devices/temp-kitchen/status",
        {
            "deviceId": "temp-kitchen",
            "name": "ESP8266 Temp Sensor",
            "type": "sensor",
            "temperature": kitchen,
            "humidity": round(45.4 + random.uniform(-0.5, 0.5), 1),
            "location": "kitchen",
            "observedAt": now_iso(),
        },
        retain=not args.no_retain,
    )
    publish(
        args,
        "devices/temp-garage/status",
        {
            "deviceId": "temp-garage",
            "name": "ESP8266 Temp Sensor",
            "type": "sensor",
            "temperature": garage,
            "humidity": round(56.1 + random.uniform(-0.6, 0.6), 1),
            "location": "garage",
            "observedAt": now_iso(),
        },
        retain=not args.no_retain,
    )
    publish(
        args,
        "shelly/events/shellyplus1-78ee4ccf4b54",
        {
            "src": "shellyplus1-78ee4ccf4b54",
            "method": "NotifyStatus",
            "params": {"switch:0": {"id": 0, "output": switch_on, "apower": 12.5 if switch_on else 0}},
            "observedAt": now_iso(),
        },
        retain=False,
    )


def publish(args, topic, payload, retain=False):
    message = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    if args.dry_run:
        print(f"{topic} {message}")
        return

    command = [
        "mosquitto_pub",
        "-h",
        args.host,
        "-p",
        str(args.port),
        "-t",
        topic,
        "-m",
        str(message),
    ]
    if retain:
        command.append("-r")
    if args.username:
        command.extend(["-u", args.username])
    if args.password:
        command.extend(["-P", args.password])

    subprocess.run(command, check=True)
    print(f"published {topic}")


def topic_part(value):
    cleaned = "".join(ch.lower() if ch.isalnum() or ch in "-_" else "_" for ch in str(value).strip())
    return cleaned.strip("_") or "unknown"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    sys.exit(main())
