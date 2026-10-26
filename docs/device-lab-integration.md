# Device Lab and Python integration

## What is in this checkout

`device-scripts/device-lab/` is a Node.js local simulator with a browser UI, JSON configuration/state, simulator adapters and an in-process MQTT command subscriber/publisher. It includes MQTT, HTTP, Modbus and Zigbee simulator classes. It is not a Python package and does not provide production device drivers.

The Python scripts in `device-scripts/` are separate fixtures:

- `publish-fake-site-devices.py` publishes a configured sample device registry and synthetic telemetry through the `mosquitto_pub` executable.
- `serve-fake-http-device.py` serves synthetic JSON values at `/`, `/status` and `/state` using Python's standard library. It is not the Energrid firmware identity API and does not implement `GET /api/v1/identity` or `/api/v1/diagnostics`.
- `publish-mqtt-explorer-fixtures.py` seeds synthetic retained/live topics for the Portal MQTT explorer view. It does not establish enrollment or command authority.

The checkout has no Python Device Lab client library, typed Python protocol package or documented direct Python-to-API ingestion contract. Treat these as test/support utilities, not a stable SDK.

## Local fixture use

Use a local/test broker and non-production tenant/site values. These commands only describe the supported CLI arguments; they do not start or contact a service here.

```sh
python3 device-scripts/publish-fake-site-devices.py \
  --tenant tenant-demo --site site-lab --host 127.0.0.1 --port 1883 --dry-run

python3 device-scripts/publish-fake-site-devices.py \
  --tenant tenant-demo --site site-lab --host 127.0.0.1 --port 1883 --count 1

python3 device-scripts/serve-fake-http-device.py \
  --host 127.0.0.1 --port 8088 --device-id sample.temperature
```

Without `--dry-run`, the MQTT publisher requires `mosquitto_pub` on `PATH`; optional username/password parameters exist, but use a dedicated local credential and avoid exposing it in shell history/process arguments. `--count 0` runs indefinitely. The fake HTTP server binds only to loopback by default; exposing it to a LAN is unnecessary for local checks.

The fake HTTP response includes its sample `deviceId`, `name`, changing `values`, and `observedAt`. It should only be connected to an explicitly configured test integration that accepts that fixture contract. It is not proof that the approved Energrid HTTP observation flow works, because that flow also requires scope-matched physical identity verification and an approved installation binding.

## Device Lab simulator boundary

The Node Device Lab's runtime profiles and device records are local simulator configuration. Simulator commands and simulated acknowledgements test transport/UI behavior; they do not reach physical hardware or create production enrollment. Keep the LAB route loopback-only and use the guarded `LAB_MQTT_*` settings and explicitly scoped route configuration. The API runtime rejects the LAB observation-binding variable in production.

## Integration guidance

If adding a Python integration, define a versioned schema and stable sample/evidence ID first. Document authentication, tenant/site scoping, retry/duplicate behavior, timestamps and failure handling. Feed observations through a trusted API adapter/domain port rather than writing to PostgreSQL or LevelDB directly. Update this page and the relevant protocol/persistence guide in the same implementation milestone.
