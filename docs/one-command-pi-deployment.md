# One-command Raspberry Pi deployment

The supported Pi deployment target was verified as `pi5@192.168.1.60`. That
host runs `energrid-api`, `energrid-core`, Nginx and Mosquitto. The address
`192.168.1.6` did not accept the configured SSH key during the read-only
deployment preflight; it is not the currently verified application host.

The Portal is a static Vite build served by Nginx. The API and Core run as
systemd services. Mosquitto is a separate persistent service. Deployment
updates the API, Core and Portal release only; it does not restart or change
Mosquitto, run database migrations, or modify device records.

## One-time administrator setup

From the repository root on the Mac, run:

```sh
npm run bootstrap:pi-deploy -- pi5@192.168.1.60
```

The bootstrap creates a dedicated Ed25519 SSH key, adds it to the macOS
Keychain-backed agent, installs its public key for the selected Pi account,
and asks for an explicit `SETUP` confirmation. It then asks for the Pi
administrator password interactively to install a root-owned activation helper
and one exact `NOPASSWD` sudo rule. The password is neither written to a file,
put in an argument nor printed.

The only permitted passwordless privileged command is the helper
`/usr/local/sbin/energrid-deploy-activate`, with no arguments. The helper is
installed root-owned, checksum-verified, and cannot be edited by the deployment
account. It reads one validated activation/rollback request from its private
request directory. Bootstrap creates one stable `/var/www/energrid/current`
link and updates the existing API/Core systemd paths and Nginx Portal root to
use it. A release switches that one link atomically, then restarts only
`energrid-api` and `energrid-core`. Nginx serves the new static Portal through
the link without a reload. Mosquitto is checked but never reconfigured or
restarted. Bootstrap verifies the existing service and release layout, rolls
its configuration back if its checks fail, and can be rerun idempotently.

The target is saved in the user's local config directory with restrictive
permissions. No target or credential is committed to the repository.

## Normal release

After bootstrap, run:

```sh
npm run deploy:pi
```

The script requires `main`, uses committed `HEAD`, and builds API, Core and
Portal from a clean temporary source archive. It refuses tracked application
edits, excludes local environment files, and records the full commit and unique
release ID. It uses strict SSH host-key checking and batch key authentication.
It stages a versioned release, installs dependencies inside that new release,
then requests the root helper with `sudo -n`—ordinary releases never prompt for
a sudo password.

Activation uses atomic same-filesystem link replacement. A root-owned systemd
environment file stamps the requested release ID and full commit. The helper
verifies that API and Core loaded those exact values and run through the shared
release path, that the static Portal's `/release.json` reports the expected
release and commit, and that API, Core, Portal, Nginx and Mosquitto are healthy.
It does not treat HTTP success alone as proof of version.

If a post-activation check fails, the helper restores the prior release link
and release identity, restarts API/Core, and verifies recovery. Failed and previous
releases are retained. To intentionally roll back to the previous successful
release, run:

```sh
npm run rollback:pi
```

The rollback uses the same fixed helper and the same health checks.

## Dry run and limits

Before one-time bootstrap, a local build/package check can be run without SSH
or Pi changes:

```sh
ENERGRID_PI_SSH_TARGET=pi5@192.168.1.60 npm run deploy:pi -- --dry-run
```

The deployment script does not migrate PostgreSQL. Review and back up the
correct database before separately authorized schema changes. Persistent
`/home/pi5/.energrid`, `/var/www/energrid/.env`, the API authentication
environment file, PostgreSQL and Mosquitto state remain outside replaceable
release directories.

An operator must verify the target and Pi sudo password during one-time
bootstrap. Do not run bootstrap against `192.168.1.6` unless that address is
independently confirmed as the intended application host and has the required
Energrid service/release layout.
