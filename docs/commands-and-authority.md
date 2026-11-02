# Commands, authorization and audit

## Control path

The API's `DeviceControlService` accepts the implemented binary switch actions (`turn_on`, `turn_off`). Other recognized capability actions are not wired to a control adapter and are rejected before transport. For an executable action, the API checks approval, active enrollment, tenant/site ownership, switching capability, explicit permission and route readiness. The scope-resolved Shelly binding selects an execution transport from verified site-owned identity, component, active endpoint, configured scope and observer. Group control validates every member and detects cycles before dispatch.

The adapter sends a Shelly RPC payload over the resolved or explicitly configured route, or a generic MQTT command payload. The command enters a pending state before transport. Transport success alone is not settled success: fresh matching state readback is required. Transport errors are reported failed or uncertain according to the adapter result. Stale or mismatched readback cannot confirm the requested state.

```mermaid
sequenceDiagram
  participant Portal
  participant API as API command service
  participant Auth as Site / enrollment / binding checks
  participant Adapter as MQTT or HTTP adapter
  participant Device
  participant Obs as Observation ingress
  Portal->>API: Request supported action
  API->>Auth: Validate trust, tenant/site, capability, enrollment, binding
  Auth-->>API: Authorize scope, or reject before dispatch
  API->>API: Record pending command in device runtime state
  API->>Adapter: Send bounded command
  Adapter->>Device: MQTT publish or HTTP request
  Adapter-->>API: Transport success or error
  Device-->>Obs: Later reported state, when available
  Obs->>API: Reconcile expected state
  API-->>Portal: pending, success or failed result
```

## Authorization boundary

- Portal authentication and site context are enforced server-side. The browser does not choose an arbitrary tenant/site scope for control.
- A discovery candidate is not a control target until approval, active enrollment and a valid binding exist.
- Inferred reachability, publisher identity, physical inventory and logical enrollment are separate evidence and authorization states.
- Missing credentials, transport binding or unsupported action fail closed; no command should be sent when a prerequisite fails.
- Capability, enrollment, explicit per-component switching permission and executable route readiness are separate checks. Measurement approval and assistant permission remain separate. Read-only status collection does not grant switching authority.
- Historical endpoint observations do not silently select a route. A current endpoint must match the active configured site scope and authorized observer. The Home route validation failures observed on 2 November 2026 are listed in the backlog; no physical command was sent.

## Audit and retention limits

Do not call the current control trail a durable command audit. Device runtime command state lives in the registry and is not a durable append-only command ledger. `OperationalLogService` is an in-memory bounded ring (default 500 general entries, plus bounded per-device MQTT-stage entries). The PostgreSQL `auth.audit_events` table records authentication audit events; it is not wired as a device-command audit sink. MQTT publisher attribution is a separate broker-evidence record, not a record of user authorization or command outcome.

This means a restart can remove recent operational-log context, and the checked-in code does not establish a durable, user-attributed, tamper-evident command history. Treat a durable device-command audit ledger, its retention/access policy and integration with authenticated actor context as an open architecture gap before claiming regulated or safety-grade audit coverage.

## Related references

- [Portal authentication](portal-authentication.md)
- [Device model and lifecycle](device-model-lifecycle.md)
- [Device control notes](device-control.md)
- [Mosquitto publisher attribution](../deploy/mosquitto/README.md)

Implementation anchors: [device control service](../apps/api/src/app/modules/devices/device-control.service.ts), [device control bindings](../apps/api/src/app/modules/devices/bindings/device-binding.registry.ts), and [bounded in-memory operational log](../apps/api/src/app/modules/devices/operational-log.service.ts).
