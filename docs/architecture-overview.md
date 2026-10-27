# Architecture overview

## Product shape

Energrid is one local-first platform for residential and commercial installations. The repository uses the same domain libraries and Core services for both; it does not define separate residential and commercial cores. Per-site configuration and workflows provide installation-specific behavior.

The API and Core are separate NestJS applications. The Portal is a Vue/Vite application. Device integrations live in the API's adapters and services; shared deterministic rules belong in the domain libraries when they can remain framework- and transport-independent.

## Repository applications and libraries

| Area | Responsibility visible in this checkout |
| --- | --- |
| `apps/api` | NestJS API, Portal routes/context, device registry and control, MQTT/HTTP integration, auth, telemetry ingress, account-scoped personal expenses, and local stores. |
| `apps/core` | NestJS Core HTTP app; estimator, installations, forecasts, weather and Core PostgreSQL migrations. |
| `apps/portal` | Vue 3/Vite browser UI; calls API routes and does not own device identity or authorization decisions. |
| `apps/api-e2e` | API end-to-end test project. |
| `libs/domain-devices` | Framework-independent device identity, enrollment and observation/diagnostic domain behavior. |
| `libs/domain-telemetry` | Telemetry validation, measurement semantics and aggregation helpers. |
| Other `libs/*` | Automation, voice, shared types and shared utilities; see each library README. |
| `packages/stt-stream-*` | Workspace packages for voice streaming providers and their shared contract. |
| `device-scripts/` | Local operational scripts, simulated site devices and the Device Lab. |
| `deploy/` | Checked-in deployment examples/configuration, including site gateway and Mosquitto materials. |

Project definitions: [`apps/api/project.json`](../apps/api/project.json), [`apps/core/project.json`](../apps/core/project.json), [`apps/portal/project.json`](../apps/portal/project.json), and [`nx.json`](../nx.json). The root [package scripts and dependencies](../package.json) define local commands.

Nx discovers projects from `project.json` and inferred plugin targets in `nx.json`. The root `package.json` contains runtime and development commands. There is no separate production Core package boundary implied by the Nx layout.

## System context

```mermaid
flowchart LR
  Person[Operator / installer] --> Portal[Portal - Vue]
  Portal --> API[API - NestJS]
  API --> Domain[Domain libraries]
  Core[Core - NestJS] --> Domain
  API --> PG[(PostgreSQL)]
  Core --> PG
  API --> Local[(API local stores)]
  MQTT[MQTT broker] <--> API
  Gateway[Site gateway / LAN devices] <--> API
  Core --> Providers[Weather and model providers]
```

The diagram shows repository-level relationships, not a deployment guarantee. API and Core database connections are configured independently; a particular deployment may use the same or separate PostgreSQL databases. Provider calls and LAB-only features are opt-in/configuration-dependent.

## Dependency boundaries

- Domain libraries should carry deterministic rules and typed contracts, without NestJS, SQL, MQTT or network clients. Enrollment uses a repository port; the API supplies the PostgreSQL adapter.
- API application services coordinate domain rules with protocol adapters and persistence.
- Inbound adapters translate transport evidence into typed inputs. Transport reachability alone is not device identity, enrollment, observation approval or control authorization.
- Core owns its HTTP application and forecast/estimator behavior. The checked-in Core migration directory also contains shared auth, device-inventory and telemetry schemas used by the API; migration ownership is in `apps/core/migrations`, not proof that the API imports Core services.
- The Portal carries user interaction. Site scope and administrative access are resolved and enforced server-side.
- Personal expenses are account-scoped rather than site-scoped. Their authenticated API and dedicated local store remain separate from energy telemetry and device inventory.

## Current-state boundary

Implemented capabilities and known gaps are summarized in the [audit and remaining gaps](audit-and-gaps.md). A separate Device Health Core-query milestone is in progress outside the base commit used for this documentation worktree; its final query contract is intentionally not described as implemented here.
