# Device model and lifecycle

## Scope first

The current inventory and enrollment contracts carry `tenantId`, `siteId` and a logical `deviceId`. These are scope values in the checked-in schema; the migrations shown here do not create tenant or site master tables. Cross-site work must preserve both tenant and site scope.

## Logical device and physical inventory

An **enrollment** is the logical, site-scoped authorization record. It has a display name, status, version and enrollment timestamps. It is explicit; discovery does not automatically enroll a device. Supported transitions include enroll, suspend, reactivate, retire and reenroll; state changes carry an actor and event ID, and the PostgreSQL adapter writes state plus event in one transaction with optimistic version checking.

A **physical device** is a protocol-independent asset record. It can have identity claims, components, endpoints and network observations. An identity claim records namespace/value, evidence source and verification status (`protocol_observed`, `user_confirmed`, or `hardware_verified`). A protocol-observed claim does not by itself mean a human confirmed the asset.

A **component** is a physical-device component with a stable component key and capabilities. A **logical component assignment** associates an enrolled logical device with a physical device and optionally one component key and role. This is the explicit bridge between control/telemetry-facing logical IDs and physical assets. The schema permits one assignment per logical enrollment; component-bearing assignments are unique per physical component.

```mermaid
erDiagram
  ENROLLMENT ||--o| LOGICAL_ASSIGNMENT : maps
  PHYSICAL_DEVICE ||--o{ LOGICAL_ASSIGNMENT : backs
  PHYSICAL_DEVICE ||--o{ IDENTITY_CLAIM : has
  PHYSICAL_DEVICE ||--o{ COMPONENT : exposes
  PHYSICAL_DEVICE ||--o{ ENDPOINT : reached_at
  PHYSICAL_DEVICE ||--o{ NETWORK_OBSERVATION : observed_on
  ENROLLMENT ||--o{ ENROLLMENT_EVENT : changes
  ENROLLMENT {
    text tenant_id
    text site_id
    text device_id
    text status
    bigint version
  }
  LOGICAL_ASSIGNMENT {
    text tenant_id
    text site_id
    text device_id
    text physical_device_id
    text component_key
    text logical_role
  }
  PHYSICAL_DEVICE {
    text tenant_id
    text site_id
    text physical_device_id
  }
  IDENTITY_CLAIM {
    text identity_namespace
    text identity_value
    text verification_status
    boolean is_current
  }
  COMPONENT {
    text component_key
    text capabilities
  }
  ENDPOINT {
    text protocol
    text endpoint_kind
    text address
  }
  NETWORK_OBSERVATION {
    inet ip_address
    text network_scope
    text verification_status
    boolean is_current
  }
```

Relationships correspond to composite tenant/site-scoped foreign keys in the migration, not a global cross-site identity graph. `logical_component_assignments.component_key` is nullable, so an assignment can target a physical device without selecting a component.

Implementation anchors: [enrollment migration](../apps/core/migrations/1792391460218_device-enrollment-v1.js), [physical inventory migration](../apps/core/migrations/1792470000000_physical-device-inventory-v1.js), [enrollment domain library](../libs/domain-devices/src/lib/device-enrollment.ts), and [PostgreSQL enrollment adapter](../apps/api/src/app/modules/devices/enrollment/postgres-device-enrollment.repository.ts).

## Lifecycle stages

1. **Discovery** records candidate/reachability and protocol evidence in API discovery memory and, for physical inventory flows, PostgreSQL. ICMP, ARP, router and MQTT publisher evidence are not interchangeable identity proofs.
2. **Identity verification** checks a stable protocol identity against a physical identity claim within site/network scope. HTTP candidates use `GET /api/v1/identity`; a mismatch or stale identity prevents the observation adapter from trusting the endpoint.
3. **Enrollment** is an explicit action. Enrollment is independent of discovery, observation admission and connectivity. Its status and event history are persisted in PostgreSQL.
4. **Assignment** connects the enrolled logical ID to a physical device/component. The inventory repository enforces scope, identity uniqueness and assignment constraints.
5. **Observation admission** requires trusted installation and authorization context. State projection is separate from physical identity; rejected or duplicate evidence is recorded as a decision in the observation store.
6. **Control** additionally checks approved trust, site scope, active enrollment, supported action and a ready adapter binding. An approved MQTT observation or verified HTTP identity does not alone authorize a command.

## Status and authority are separate

Discovery status, physical identity verification, logical enrollment, trust/approval, observation admission, connectivity and health are distinct concepts. For example, a device can be discoverable but unenrolled; a device can be enrolled while currently unreachable; a recent sample can be fresh without proving command capability. See [observation pipelines](observation-pipelines.md) and [commands and authority](commands-and-authority.md).
