# Energrid

Energrid is a local-first platform for residential and commercial installations. A shared deterministic Core provides domain behavior; API adapters, site services and the Portal connect it to people, devices and deployment environments.

## Engineering handbook

Start at the [handbook index](docs/index.md) for architecture, lifecycle, persistence, operations and integration guides. The index also links to the existing topic documents.

To preview the handbook locally:

```sh
pnpm install
pnpm docs:dev
```

For application commands and current runtime setup, use the [local operations guide](docs/operations.md).

## Network discovery

Energrid discovers devices from the backend/site brain, not the browser. An installation can contain multiple configured IPv4 networks. Successful probes establish reachability, not identity or control permission; a failed probe does not establish that a device is offline. See the [site gateway and discovery guide](docs/site-gateway-bootstrap.md).

## Portal authentication

Portal accounts, API authorization boundaries and local setup are documented in the [Portal authentication guide](docs/portal-authentication.md).
