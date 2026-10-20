# Mosquitto publisher attribution

This plugin targets Mosquitto plugin API v5. Mosquitto 2.0.18 supports message-in and disconnect callbacks, but has no connect callback. A publish event therefore proves that the named broker connection published that topic; a disconnect event is emitted when the broker supplies its disconnect callback.

The plugin reads only Shelly-shaped topics. It does not retain MQTT payloads or credentials. For each publish it sends a version 1 envelope to `energrid/broker-evidence/v1`, including a SHA-256 digest of the payload. The envelope is authenticated with HMAC-SHA-256. Broker-side publishing uses Mosquitto's broker publish API and does not change the originating message's QoS, topic, payload, or authorization.

## Build

Build on the Raspberry Pi against its installed Mosquitto 2.0.18 development headers and OpenSSL development package:

```sh
make -C deploy/mosquitto MOSQUITTO_INCLUDE_DIR=/usr/include
```

The 2.0.18 broker is installed on the Pi, but the `libmosquitto-dev` headers are not currently installed. This build prerequisite must be installed in a separately approved deployment window; it is not added by this work. The plugin API signatures were checked against the upstream Eclipse Mosquitto `v2.0.18` headers.

## Key and topic handling

Generate a unique random key of at least 32 bytes outside the repository. Install the same UTF-8 key as a mode `0400` file readable by the Mosquitto service account on the broker and as `HOME_MQTT_ATTRIBUTION_HMAC_KEY` in Energrid's protected runtime environment. The plugin rejects a key file that is not a regular file or is readable/writable by group or other users. Never place the key in Git or broker logs.

Merge `energrid-broker-evidence.conf.example` into the existing broker configuration only after reviewing the current authentication/ACL configuration. Do not grant MQTT clients write access to the evidence topic. Grant read access only to the dedicated Energrid attribution client; Mosquitto's broker-originated publish bypasses client write ACL checks, while normal subscriber read ACLs still apply. The HMAC check remains mandatory in Energrid even with that ACL.

Enable Energrid attribution only when all of these protected settings are supplied:

- `HOME_MQTT_ATTRIBUTION_ENABLED=true`
- `HOME_MQTT_ATTRIBUTION_BROKER_ID` (same value as `plugin_opt_broker_id`)
- `HOME_MQTT_ATTRIBUTION_CLIENT_ID` (stable and unique)
- `HOME_MQTT_ATTRIBUTION_HMAC_KEY` (same key as the broker file)

The subscriber uses a persistent QoS 1 session and reconnects automatically. The event is correlated to an Energrid-parsed Shelly message by exact topic and payload digest, never by assuming the MQTT client ID is the Shelly ID. Events that are ambiguous across publishers are not correlated.

The peer IP is stored separately as broker connection evidence. Only RFC1918 IPv4 addresses in a configured Energrid network zone are candidates for a short, read-only `Shelly.GetDeviceInfo` request. A matching RPC `id` is required before the address enters physical network observations and Discovery Memory. Public/NAT, configured gateway/seed, unreachable, and mismatched addresses remain broker evidence only.

Broker-assisted endpoint promotion fails closed unless each eligible zone has a complete `gatewayIps` list in `HOME_NETWORK_ZONES_JSON`, for example `{"id":"housenet","name":"HouseNet","cidr":"192.168.1.0/24","gatewayIps":["192.168.1.1"]}`. Keep it current with router/AP changes. A private source-NAT address not listed as a gateway cannot be distinguished from a device address by the broker event alone; the broker-peer address is still displayed as unverified evidence. Use independent router/neighbor evidence to resolve that case.

The API accepts envelopes up to 8 KiB with a valid broker ID, HMAC, and timestamp no older than 30 seconds (5 seconds of future skew). In-memory correlation state is TTL-limited and size-bounded. PostgreSQL publisher evidence is retained for 90 days; cleanup runs on API startup and daily while attribution is enabled.

## Safe rollout sequence

1. Build and inspect the plugin artifact against the broker's 2.0.18 headers and target architecture.
2. Create and distribute a fresh key through an approved secret channel; configure the dedicated subscriber ACL without changing device authentication.
3. Apply the new PostgreSQL migration to the intended environment through the normal reviewed migration process.
4. Install the plugin and its configuration, then restart Mosquitto only with separate approval.
5. Enable the API subscriber and verify signed event ingestion, RPC identity matching, and Pending Enrollment freshness. Do not approve enrollment or issue device commands as part of rollout.
