# Energrid engineering handbook

This handbook describes the repository at the commit from which this branch was created. It separates current implementation from proposals and notes where the current checkout cannot verify a contract. Source and migrations remain authoritative.

## Start here

- [Architecture overview](architecture-overview.md): applications, libraries, boundaries and data paths.
- [Collection and ingestion](collection-and-ingestion.md): scheduled HTTP collection, MQTT push, manual discovery, persistence boundaries and roadmap.
- [Device model and lifecycle](device-model-lifecycle.md): installation scope, physical inventory, logical enrollment, components and identity.
- [Shelly Pro 2PM onboarding](shelly-pro2pm-switch-onboarding.md): isolated switch-profile verification and onboarding path; not activated.
- [Observation and identity flows](observation-pipelines.md): MQTT ingestion, HTTP polling, identity verification and failure handling.
- [Commands, authorization and audit](commands-and-authority.md): current control gates, command acknowledgement and audit limitations.
- [Persistence map](persistence.md): PostgreSQL schemas, LevelDB ownership and local key families.
- [Operations and deployment](operations.md): local commands, configuration sources, deployment references and safe operational guidance.
- [Python Device Lab integration](device-lab-integration.md): simulator purpose, currently implemented transports and integration boundaries.
- [Audit and remaining gaps](audit-and-gaps.md): what this pass found and which areas need follow-up.

Architecture decisions are indexed in [Architecture decisions](decisions/index.md). They state design direction separately from implemented behavior.

## Existing topic guides

These documents predate the handbook and remain useful for narrower topics. Read dates and scope notes inside each guide before treating a procedure as current.

### Devices and site operations

- [Device control](device-control.md)
- [Device Health history V1](device-health-history.md)
- [Installation Passport](installation-passport.md)
- [Site gateway bootstrap](site-gateway-bootstrap.md)
- [HTTP observation ingestion](energrid-http-observation-ingestion.md)
- [Residential pilot](residential-pilot.md)

### Portal and deployment

- [Portal authentication](portal-authentication.md)
- [Personal expenses](personal-expenses.md): account-scoped spending, local persistence and legacy JSON import.
- [Portal Cloudflare / Pi deployment](portal-cloudflare-pi-deploy.md)
- [Mac LAB persistence](mac-lab-persistence.md)
- [API docs and OpenAPI](api-docs.md)
- [Mosquitto publisher attribution](../deploy/mosquitto/README.md)

### Energy, estimator, weather and voice

- [Electrical telemetry](electrical-telemetry.md)
- [Legacy power history](legacy-power-history.md)
- [Local estimator testing](local-estimator-testing.md)
- [Estimator revision](estimator-revision.md)
- [Estimator assistant integration](estimator-assistant-integration.md)
- [Residential template](residential-template.md)
- [Forecast verification](forecast-verification.md)
- [Weather Investigator V1](M3-weather-investigator-v1.md)
- [Voice local STT](voice-local-stt.md)
- [Voice Pi/browser deployment](voice-pi-browser-deploy.md)
- [Voice hardware simulation](voice-hardware-simulation.md)
- [Conversation testing](conversation-testing.md)
- [Conversation refactor review](conversation-refactor-review.md) — design review, not an implementation record.

### Library notes

- [Domain devices](../libs/domain-devices/README.md)
- [Domain telemetry](../libs/domain-telemetry/README.md)
- [Domain automation](../libs/domain-automation/README.md)
- [Domain voice](../libs/domain-voice/README.md)
- [Automation core](../libs/automation-core/README.md)
- [Shared types](../libs/shared-types/README.md)
- [Shared utilities](../libs/shared-utils/README.md)
- [Generic measurement history](../apps/api/src/app/modules/telemetry/generic-measurements/README.md)

## Status vocabulary

- **Implemented** means visible in this checkout's application code, migrations or deployment configuration.
- **In progress / unverified** means this checkout cannot confirm the final contract or behavior. Do not treat a design note as a shipped feature.
- **Roadmap** means a future direction without an implementation claim.
