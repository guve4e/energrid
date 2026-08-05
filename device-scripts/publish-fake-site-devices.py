#!/usr/bin/env python3

import argparse
import json
import random
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone


DEFAULT_DEVICES = [
    {
        "deviceId": "kitchen.light.wall.led",
        "name": "Kitchen wall lights",
        "kind": "switch",
        "origin": "shelly",
        "protocol": "mqtt",
        "transport": "mqtt",
        "location": "kitchen",
        "physicalId": "shellyplus1-cc7b5c0ea5f8",
        "channel": 0,
        "groups": ["kitchen.lights"],
        "values": {"on": False},
    },
    {
        "deviceId": "kitchen.light.island.led",
        "name": "Kitchen island lights",
        "kind": "switch",
        "origin": "shelly",
        "protocol": "mqtt",
        "transport": "mqtt",
        "location": "kitchen",
        "physicalId": "shellyplus1-78ee4ccf4b54",
        "channel": 0,
        "groups": ["kitchen.lights"],
        "values": {"on": False},
    },
    {
        "deviceId": "kitchen.light.cans",
        "name": "Kitchen ceiling cans",
        "kind": "switch",
        "origin": "shelly",
        "protocol": "mqtt",
        "transport": "mqtt",
        "location": "kitchen",
        "physicalId": "shellyplus1-78ee4ccf4268",
        "channel": 0,
        "groups": ["kitchen.lights"],
        "values": {"on": False},
    },
    {
        "deviceId": "temp-kitchen",
        "name": "Kitchen temperature",
        "kind": "sensor",
        "origin": "native",
        "protocol": "mqtt",
        "transport": "mqtt",
        "location": "kitchen",
        "capabilities": ["temperature", "humidity"],
        "values": {"temperature": 22.4, "humidity": 48.0},
    },
    {
        "deviceId": "temp-garage",
        "name": "Garage temperature",
        "kind": "sensor",
        "origin": "native",
        "protocol": "mqtt",
        "transport": "mqtt",
        "location": "garage",
        "capabilities": ["temperature", "humidity"],
        "values": {"temperature": 18.7, "humidity": 56.1},
    },
    {
        "deviceId": "panel.mainline.energy",
        "name": "Whole house mainline",
        "kind": "physical",
        "origin": "shelly",
        "protocol": "mqtt",
        "transport": "mqtt",
        "driver": "shelly-pro-em",
        "target": "shelly/mainline@water-pump",
        "location": "panel",
        "physicalId": "shellyproem50-8c4f00dbd258",
        "hardwareId": "shellyproem50-8c4f00dbd258",
        "channel": 0,
        "channelName": "mainline",
        "component": "em:0",
        "capabilities": ["power"],
        "values": {"power": 420.0, "current": 1.9, "energy": 108.2},
    },
    {
        "deviceId": "shed.water_pump.energy",
        "name": "Water pump energy",
        "kind": "physical",
        "origin": "shelly",
        "protocol": "mqtt",
        "transport": "mqtt",
        "driver": "shelly-pro-em",
        "target": "shelly/mainline@water-pump",
        "location": "shed",
        "physicalId": "shellyproem50-8c4f00dbd258",
        "hardwareId": "shellyproem50-8c4f00dbd258",
        "channel": 1,
        "channelName": "water-pump",
        "component": "em:1",
        "capabilities": ["power", "pump"],
        "values": {"power": 0, "current": 0.02, "energy": 7.9},
    },
]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publish fake Energrid site devices to a Mosquitto broker."
    )
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--site", required=True)
    parser.add_argument("--gateway", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default="1883")
    parser.add_argument("--username", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--devices", default=None, help="Path to a JSON file with a devices array.")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--count", type=int, default=1, help="Number of telemetry rounds. Use 0 for forever.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--retain-registry", action="store_true")
    args = parser.parse_args()

    devices = load_devices(args.devices)
    prefix = "/".join(["energrid", topic_part(args.tenant), topic_part(args.site)])
    gateway_id = args.gateway or f"{topic_part(args.site)}-gateway"

    publish_json(
        args,
        f"{prefix}/gateway/{topic_part(gateway_id)}/status",
        {
            "tenantId": args.tenant,
            "siteId": args.site,
            "gatewayId": gateway_id,
            "status": "online",
            "observedAt": now_iso(),
            "transport": "mqtt",
        },
        retain=True,
    )

    registry = {
        "tenantId": args.tenant,
        "siteId": args.site,
        "gatewayId": gateway_id,
        "devices": devices,
        "observedAt": now_iso(),
    }
    publish_json(args, f"{prefix}/registry/devices", registry, retain=args.retain_registry)

    rounds = 0
    while args.count == 0 or rounds < args.count:
        rounds += 1
        for device in devices:
            payload = next_payload(device)
            device_id = topic_part(device["deviceId"])
            publish_json(args, f"{prefix}/devices/{device_id}/telemetry", payload)
            publish_json(
                args,
                f"{prefix}/devices/{device_id}/status",
                {
                    "tenantId": args.tenant,
                    "siteId": args.site,
                    "gatewayId": gateway_id,
                    "deviceId": device["deviceId"],
                    "status": "online",
                    "observedAt": payload["observedAt"],
                },
                retain=True,
            )
        if args.count == 0 or rounds < args.count:
            time.sleep(args.interval)

    return 0


def load_devices(path):
    if not path:
        return DEFAULT_DEVICES
    with open(path, "r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    devices = parsed.get("devices") if isinstance(parsed, dict) else parsed
    if not isinstance(devices, list):
        raise SystemExit("Device file must be a JSON array or an object with a devices array.")
    return devices


def next_payload(device):
    values = dict(device.get("values") or {})
    kind = str(device.get("kind") or device.get("type") or "").lower()

    if "temperature" in values:
        values["temperature"] = round(float(values["temperature"]) + random.uniform(-0.12, 0.12), 2)
    if "humidity" in values:
        values["humidity"] = round(float(values["humidity"]) + random.uniform(-0.4, 0.4), 1)
    if "power" in values:
        values["power"] = round(max(0, float(values["power"]) + random.uniform(-35, 35)), 1)
    if kind == "switch" and "on" in values:
        values["on"] = bool(values["on"])

    return {
        "deviceId": device["deviceId"],
        "name": device.get("name") or device["deviceId"],
        "kind": kind or "device",
        "origin": device.get("origin", "fake"),
        "protocol": device.get("protocol"),
        "transport": device.get("transport"),
        "driver": device.get("driver"),
        "bridge": device.get("bridge"),
        "target": device.get("target"),
        "location": device.get("location", "unknown"),
        "physicalId": device.get("physicalId"),
        "hardwareId": device.get("hardwareId"),
        "channel": device.get("channel"),
        "channelName": device.get("channelName"),
        "component": device.get("component"),
        "capabilities": device.get("capabilities"),
        "groups": device.get("groups", []),
        "metadata": device.get("metadata", {}),
        "values": values,
        "observedAt": now_iso(),
    }


def publish_json(args, topic, payload, retain=False):
    message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    if args.dry_run:
        print(f"{topic} {message}")
        return

    if not shutil.which("mosquitto_pub"):
        raise SystemExit("mosquitto_pub not found. Install mosquitto-clients or run with --dry-run.")

    command = [
        "mosquitto_pub",
        "-h",
        args.host,
        "-p",
        str(args.port),
        "-t",
        topic,
        "-m",
        message,
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
