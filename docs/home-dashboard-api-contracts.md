# Energrid Home dashboard API contracts

This document records the existing LAB contracts used by the purpose-built
Home Dashboard at `/d/home`. The dashboard is presentation code. It must call
the Energrid API, which remains the only public boundary to Core, device
authorization, site state and Assistant policy. Do not call Core directly from
the browser or put Core, MQTT, Shelly or control credentials in a dashboard.

The current Portal API contracts below require an authenticated access token
with the `admin` role. The backend binds the request to its configured tenant
and site; the client must not select another tenant/site by changing a URL or
request body. These endpoints are not a customer-role/site-membership API.
Any future customer-facing authorization contract must be implemented and
documented server-side before another dashboard relies on it.

All HTTP requests use the Portal/API origin and send:

```http
Authorization: Bearer <accessToken>
Accept: application/json
```

## Session

| Method and path | Purpose | Contract |
| --- | --- | --- |
| `POST /auth/login` | Sign in | JSON `{ "email": string, "password": string }`; returns `{ accessToken, user }`. |
| `GET /auth/me` | Validate the access token | Returns the current authenticated user. A `401` means the session must be restored or renewed. |
| `POST /auth/refresh` | Renew an expired access token | Uses the existing CSRF-protected refresh-cookie flow. Send credentials and the CSRF header as required by `apps/api/src/app/modules/auth/auth.controller.ts`; do not implement a second session mechanism. |
| `POST /auth/logout` | End the session | Revokes the refresh session and clears its cookie. |

The existing Vue auth client keeps the short-lived access token in memory and
uses the API refresh cookie for renewal. It sends credentials with same-origin
API requests, coordinates refresh across tabs, and replays a request once after
a successful renewal. New dashboard clients should reuse this client and its
cookie rules rather than storing access tokens in browser storage.

## Authorized home state and climate

### `GET /portal/state`

Returns the configured site snapshot. Relevant response fields:

```json
{
  "tenant": { "id": "…", "name": "…" },
  "site": { "id": "…", "name": "…", "mode": "home" },
  "zones": [{
    "id": "…", "name": "Kitchen",
    "sensors": [{
      "id": "…", "name": "Kitchen temperature",
      "capability": "temperature", "value": 21.4,
      "unit": "C", "observedAt": "…", "source": "…"
    }]
  }],
  "devices": [{
    "id": "…", "displayName": "…", "zoneName": "…",
    "trustStatus": "approved",
    "capabilities": [{ "kind": "temperature", "actions": ["read"], "unit": "C" }],
    "state": { "values": {}, "observedAt": "…", "status": "online" }
  }]
}
```

Use only enrolled/approved sensor devices and their authorized observation
fields. Treat timestamps and `state.status` as separate evidence: `offline`
means the device is unreachable; an old or absent field is an unavailable or
stale measurement. Do not substitute example or cached values as live values.
The current Portal API returns the configured site snapshot and is
administrator-only (`PortalController`); site scoping is enforced by the
server's configured registry, not by a dashboard-supplied site ID.

### `GET /portal/devices/:deviceId/measurements?metric=temperature&from=<ISO>&to=<ISO>&limit=<n>`

Returns authorized observation history for an enrolled device and metric. The
API checks that the device belongs to the active backend tenant/site and that
the field has active installation observation authority. Typical response:

```json
{
  "deviceId": "…", "metric": "temperature", "unit": "C",
  "from": "…", "to": "…",
  "measurements": [{ "observedAt": "…", "value": 21.4, "unit": "C", "quality": "…" }]
}
```

The range is bounded by the API. A `403` means the field is not authorized for
history; `404` means the enrolled device is not in the configured site.

## Weather

### `GET /portal/weather/dashboard`

Administrator-authenticated Portal bridge to Core's configured
`GET /core/weather/dashboard`. The weather location comes from Core
configuration. The response contains `location`, `fetchedAt`, `current`,
`daily` and `dataQuality`; optional forecast/intelligence fields may be absent
when upstream weather is unavailable. Display unavailable/stale status from
that response and do not manufacture fallback weather values. The browser never
receives the private Core token.

## Approved Shelly and relay actions

### `POST /portal/devices/:deviceId/actions`

```http
Content-Type: application/json
```

```json
{ "action": "turn_on" }
```

`action` is a capability action exposed by the registered device. A successful
response includes the device/action, `status` (`success`, `pending` or
`failed`), adapter, message, affected device IDs and command evidence when
available. The dashboard may present a control only for a configured,
approved device that advertises both `turn_on` and `turn_off`. This is only a
presentation rule: API authorization, approved-device checks, driver routing,
confirmation policy and physical execution remain server-side. Never send a
Shelly credential or raw MQTT command from the browser.

## Ask Energrid voice

### `GET /voice/protocol`

Describes the active voice transport and event names. The existing gateway is
`/voice` on the same origin (`wss` for HTTPS). It requires a first text frame:

```json
{ "type": "authenticate", "token": "<accessToken>" }
```

After authentication, send mono 16 kHz PCM16 audio as binary frames. End a turn
with `{"type":"end_of_turn"}`. The server streams `stt_partial`,
`stt_final`, `assistant_text_delta`, `assistant_audio_chunk`,
`home_action_plan`, `home_action_execution`, `assistant_final`, `turn_end` and
`error` events. Use the same access token and server-side Assistant safety and
approval policy as Portal; never add a browser-side model/provider or direct
device execution path.

## Existing backend implementation

- `apps/api/src/app/modules/portal/portal.controller.ts`
- `apps/api/src/app/modules/portal/portal-state.service.ts`
- `apps/api/src/app/modules/portal/portal-device-measurements.service.ts`
- `apps/api/src/app/modules/portal/portal-weather.controller.ts`
- `apps/api/src/app/modules/devices/device-control.service.ts`
- `apps/api/src/app/modules/voice/voice.gateway.ts`
- `apps/api/src/app/modules/voice/voice-protocol.controller.ts`
- `apps/api/src/app/modules/auth/auth.controller.ts`

No endpoint, schema, migration or production service is changed by the
standalone dashboard work.
