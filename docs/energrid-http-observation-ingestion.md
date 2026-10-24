# Energrid ESP8266 HTTP observations

The HTTP adapter accepts only the firmware 0.2 status contract from a currently fresh (`10 minute`) verified discovery record in the enrolled network scope. Before reading status it fetches `/api/v1/identity` from the current discovery address and checks the stable `esp8266:xxxxxx` identity. It then validates `schemaVersion`, `deviceId`, sensor health, numeric ranges, sample counters, and reading freshness. Poll time is not used as a source sample identity.

The firmware has no wall-clock sample timestamp or boot ID. The adapter keys evidence to `sampleCount` and `lastSampleUptimeMs`, with a boot generation kept in the same LevelDB observation store. Counter decreases advance the generation; persisted firmware uptime is also compared with elapsed API wall time to infer resets across long API outages. This survives API restarts and ordinary firmware counter resets. A major API host clock jump can make this inference ambiguous; a firmware boot/session ID is the permanent source-side fix.

## Explicit approval

Enrollment alone does not authorize readings. After the device is approved and enrolled, an operator must explicitly write the two-field source binding into its durable installation record:

```sh
pnpm device:approve-energrid-observations -- valentin boyana-home device:upstream-lan:esp8266:324864
```

The command uses `HOME_DEVICE_STORE_DIRECTORY` (or `~/.energrid/device-registry`) and verifies the matching approved Energrid ESP8266 installation. Stop the API before running it because LevelDB allows only one process to open the installation store; restart the API afterward. It authorizes `temperature` from `temperatureC` and `humidity` from `humidityPct`, from source `energrid-http-status` and selector `/api/v1/status`. It adds no control permission. The existing enrollment check remains required at ingestion.

Enable polling only after approval, with the same observation-store path on every API start:

```dotenv
HOME_HTTP_POLL_ENABLED=true
HOME_OBSERVATION_STORE_DIRECTORY=/var/lib/energrid/device-observations
```

Use a local path owned by the API process and back it up with the site gateway data. `HOME_HTTP_POLL_INTERVAL_MS` defaults to 5000 and `HOME_HTTP_POLL_TIMEOUT_MS` defaults to 2000. Failed requests mark connectivity offline; invalid/stale sensor data and mismatched identity are rejected and logged with a bounded reason code. No raw response body, endpoint credentials, or Wi-Fi secrets are logged.
