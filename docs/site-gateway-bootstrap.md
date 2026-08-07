# Site Gateway Bootstrap

Energrid treats the current LAN as one discovery source, not as the source of
truth. The source of truth is:

- tenant
- site
- gateway
- approved device registry
- protocol adapters

Mosquitto can be the local event backbone for a site. The bootstrap generator
creates a site-scoped MQTT prefix, Mosquitto ACL, and API environment file.

## Generate a Site Gateway Pack

```sh
pnpm site:gateway:init --tenant valentin --tenantName "Valentin" --site boyana-home --name "Boyana Home" --broker devicebroker.ddns.net
```

This writes files under:

```txt
deploy/site-gateway/generated/valentin-boyana-home
```

The generated MQTT topic prefix is:

```txt
energrid/valentin/boyana-home
```

Device topics should live under:

```txt
energrid/{tenantId}/{siteId}/devices/{deviceId}/state
energrid/{tenantId}/{siteId}/devices/{deviceId}/telemetry
energrid/{tenantId}/{siteId}/devices/{deviceId}/status
energrid/{tenantId}/{siteId}/devices/{deviceId}/command
energrid/{tenantId}/{siteId}/discovery/{source}/{deviceId}
```

## Device Protocols

MQTT is the site event backbone, not the only device protocol.

Each approved device has:

- `protocol`: what the device actually speaks, such as `mqtt`, `http`,
  `zigbee`, `matter`, or `modbus`
- `transport`: how Energrid receives events or sends commands, usually `mqtt`,
  `http`, or `local`
- `driver`: the adapter implementation, such as `shelly-rpc`, `http-json-sensor`,
  `zigbee2mqtt`, or `modbus-gateway`
- `bridge`: optional local bridge name, for example a Zigbee2MQTT coordinator or
  RS485 gateway

Examples:

```json
{
  "deviceId": "hall.motion.zigbee",
  "protocol": "zigbee",
  "transport": "mqtt",
  "driver": "zigbee2mqtt",
  "bridge": "zigbee2mqtt-hall",
  "target": "zigbee2mqtt/hall_motion"
}
```

```json
{
  "deviceId": "kitchen.temperature.http",
  "protocol": "http",
  "transport": "http",
  "driver": "http-json-sensor",
  "target": "http://192.168.1.88/status"
}
```

## On a Fresh Pi

After pulling the repo on the site gateway, the preferred path is the site brain
installer:

```sh
cd /var/www/energrid
pnpm site:bootstrap \
  --tenant valentin \
  --tenantName "Valentin" \
  --site boyana-home \
  --name "Boyana Home" \
  --network 192.168.1.0/24
```

That is a dry run. It prints the commands and generated config without touching
`/etc`. When the plan looks right, apply it on the Pi:

```sh
pnpm site:bootstrap \
  --tenant valentin \
  --tenantName "Valentin" \
  --site boyana-home \
  --name "Boyana Home" \
  --network 192.168.1.0/24 \
  --domain portal.energrid.bg \
  --user pi5 \
  --apply
```

The installer:

- installs nginx, Mosquitto, Mosquitto clients, and ffmpeg
- writes or updates the repo `.env` while backing up the old one
- configures the tenant, site, gateway, MQTT prefix, and network zone
- builds the API and portal
- installs nginx and systemd config
- enables and restarts `mosquitto` and `energrid-api`

Useful options:

```sh
--stt local-whisper
--whisperModel tiny
--proxyWrite true
--legacyTemperatureTopics "sensors/arduino/temp|kitchen_temperature|Kitchen|Kitchen temperature,sensors/arduino/temp2|garage_temperature|Garage|Garage temperature"
--packages false
--build false
--restart false
```

The older generator is still useful when you only want a portable gateway pack:

The generator does not install packages or edit `/etc` by itself. It prepares
the exact files so the install step is explicit and repeatable.

## Important Rule

Discovery is not authority.

MQTT, mDNS, HTTP, and LAN scan results can suggest devices. The assistant can
only control devices after they are in the approved registry for the current
tenant/site.

## Publish Fake Site Devices

Use this before touching real hardware or the old `devicebroker.ddns.net`
system.

Enable API MQTT ingest:

```sh
HOME_MQTT_INGEST_ENABLED=true
HOME_MQTT_HOST=devicebroker.ddns.net
HOME_MQTT_PORT=1883
HOME_MQTT_TOPIC_PREFIX=energrid/valentin/boyana-home
HOME_HTTP_POLL_ENABLED=true
HOME_HTTP_POLL_INTERVAL_MS=2000
HOME_LAN_ACTIVE_SCAN_ENABLED=true
HOME_LAN_ACTIVE_SCAN_MAX_HOSTS=254
HOME_NETWORK_ZONES_JSON={"zones":[{"id":"main-lan","name":"Main LAN","cidr":"192.168.7.0/24","role":"primary"},{"id":"iot-lan","name":"IoT LAN","cidr":"192.168.1.0/24","role":"iot","seedIps":["192.168.1.60","192.168.1.88"]},{"id":"camera-vlan","name":"Camera VLAN","cidr":"192.168.20.0/24","role":"camera","seedIps":["192.168.20.40"]}]}
```

Dry run:

```sh
pnpm site:devices:fake --tenant valentin --site boyana-home --dry-run
```

Publish one telemetry round to a local broker:

```sh
pnpm site:devices:fake --tenant valentin --site boyana-home --host 127.0.0.1 --count 1
```

Publish the sample registry repeatedly:

```sh
pnpm site:devices:fake \
  --tenant valentin \
  --site boyana-home \
  --host devicebroker.ddns.net \
  --username eg_boyana-home \
  --password 'change-me' \
  --devices deploy/site-gateway/example-devices.json \
  --retain-registry \
  --count 0
```

Publish a mixed-protocol fake registry:

```sh
pnpm site:devices:fake \
  --tenant valentin \
  --site boyana-home \
  --host devicebroker.ddns.net \
  --devices deploy/site-gateway/example-mixed-protocol-devices.json \
  --retain-registry \
  --count 0
```

## Simulate a Real HTTP Device

Terminal 1: start a fake HTTP device:

```sh
pnpm site:device:http --port 8088
```

Terminal 2: publish a registry that points to that HTTP device:

```sh
pnpm site:devices:fake \
  --tenant valentin \
  --site boyana-home \
  --devices deploy/site-gateway/example-http-polled-devices.json \
  --retain-registry \
  --count 1
```

Terminal 3: run the API with MQTT ingest and HTTP polling:

```sh
HOME_MQTT_INGEST_ENABLED=true \
HOME_HTTP_POLL_ENABLED=true \
HOME_HTTP_POLL_INTERVAL_MS=2000 \
PORTAL_TENANT_ID=valentin \
PORTAL_SITE_ID=boyana-home \
HOME_MQTT_TOPIC_PREFIX=energrid/valentin/boyana-home \
pnpm api
```

The registry arrives over MQTT, but the changing sensor values are read over
HTTP from `http://127.0.0.1:8088/status`.

## Scan Networks Visible From the Local Brain

The portal Discovery page asks the local site brain to scan the networks it can
see. The browser does not scan Wi-Fi. This is for installers: see what is near
the Pi/gateway, open a Shelly device settings page, then decide what should be
onboarded.

Discovery merges several local sources:

- configured network zones, usually from `HOME_NETWORK_ZONES_JSON`
- active ping/ARP probing from the site brain
- the Linux/macOS neighbour table, such as `ip neigh` or `arp -a`
- optional router/DHCP client exports
- HTTP enrichment probes, such as Shelly `/shelly` and
  `/rpc/Shelly.GetDeviceInfo`

This is why the router web UI can show many more devices than the portal scan.
The router has its DHCP/client table. The Pi's ARP/neighbour table only shows
hosts recently visible to the Pi, plus devices touched by active probing. For a
proper installer view, connect the router client table as another Discovery
source.

For simple homes, one LAN is enough. If `HOME_NETWORK_ZONES_JSON` is not set,
the gateway infers private local `/24` networks from its active interfaces. For
real installations, configure network zones so discovered devices are labelled
by the part of the site they came from:

```sh
HOME_NETWORK_ZONES_JSON='{
  "zones": [
    {
      "id": "main-lan",
      "name": "Main LAN",
      "cidr": "192.168.7.0/24",
      "role": "primary"
    },
    {
      "id": "iot-lan",
      "name": "IoT LAN",
      "cidr": "192.168.1.0/24",
      "role": "iot",
      "seedIps": ["192.168.1.60", "192.168.1.88"]
    },
    {
      "id": "camera-vlan",
      "name": "Camera VLAN",
      "cidr": "192.168.20.0/24",
      "role": "camera",
      "seedIps": ["192.168.20.40"]
    }
  ]
}'
```

`cidr` labels devices that appear in the Pi's ARP/neighbour table. `seedIps`
are actively probed, which is useful for routed subnets or devices that do not
show up in the neighbour table until contacted.

Before reading the ARP/neighbour table, the scanner does a bounded active sweep
of each configured `/24` to `/30` zone. This is why it can find quiet Shelly and
HTTP devices that were not already visible to the Pi. You can tune it with:

```sh
HOME_LAN_ACTIVE_SCAN_ENABLED=true
HOME_LAN_ACTIVE_SCAN_MAX_HOSTS=254
HOME_LAN_ACTIVE_SCAN_MAX_ZONES=4
```

API endpoint:

```sh
curl http://localhost:3000/portal/network/scan
```

The scanner reads the local ARP/neighbour table and probes HTTP device metadata
endpoints such as Shelly `/shelly` and `/rpc/Shelly.GetDeviceInfo`. Results stay
separate from approved devices until an onboarding flow explicitly trusts and
configures them.

## Include Router Client Tables

Router support is adapter-based because every router exposes its client table
differently. The Discovery service accepts normalized JSON from an env value,
file, or command:

```sh
HOME_ROUTER_CLIENTS_JSON='{"clients":[{"ip":"192.168.1.31","mac":"ec:62:60:88:80:84","hostname":"shelly-plus-1","vendor":"Shelly","model":"SPSW-202PE16EU","status":"connected"}]}'
```

```sh
HOME_ROUTER_CLIENTS_FILE=/etc/energrid/router-clients.json
```

```sh
HOME_ROUTER_CLIENTS_COMMAND=/usr/local/bin/energrid-router-clients
HOME_ROUTER_CLIENTS_COMMAND_ARGS="--router 192.168.1.1"
```

Supported JSON shapes:

```json
{
  "clients": [
    {
      "ip": "192.168.1.31",
      "mac": "ec:62:60:88:80:84",
      "hostname": "shelly-plus-1",
      "vendor": "Shelly",
      "model": "SPSW-202PE16EU",
      "status": "connected"
    }
  ]
}
```

or a plain array:

```json
[
  {
    "address": "192.168.1.88",
    "hwaddr": "8c:aa:b5:01:02:03",
    "name": "esp8266-temp",
    "manufacturer": "Espressif"
  }
]
```

Router/client-table devices are not automatically trusted. They appear as
network-visible candidates until HTTP/MQTT/device adapters prove capabilities or
the installer approves them.

## Open Device Settings Through the Gateway

When the installer is not on the same LAN as a device, the portal can open a
discovered local HTTP device through the site gateway:

```txt
/portal/device-proxy/{discoveredDeviceId}/
```

The proxy is intentionally narrow:

- the device must be present in the latest local discovery scan
- the target IP must be private LAN address space
- the gateway only talks HTTP to the device
- write methods are blocked unless installer write mode is explicitly enabled

Read-only browsing is enabled by default. To allow POST/PUT/PATCH/DELETE from
device admin pages during a supervised installer session:

```sh
PORTAL_DEVICE_PROXY_WRITE_ENABLED=true
```

This should only be enabled for trusted admin/install sessions because it gives
the portal a controlled window into local device configuration pages.

This publishes under:

```txt
energrid/valentin/boyana-home/gateway/boyana-home-gateway/status
energrid/valentin/boyana-home/registry/devices
energrid/valentin/boyana-home/devices/kitchen_light_wall_led/telemetry
energrid/valentin/boyana-home/devices/kitchen_light_wall_led/status
```

The fake publisher is intentionally separate from the old broker. Later, an
adapter can bridge selected old topics into this clean Energrid topic model.

When API ingest is enabled and the fake publisher is running, `/portal/state`
will reflect the live registry and telemetry. The portal device page will show
native protocols such as `http`, `zigbee`, and `modbus`, plus their transport
when they are bridged through MQTT.
