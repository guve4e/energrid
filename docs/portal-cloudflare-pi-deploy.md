# Portal Cloudflare Pi Deploy

Goal: expose the Energrid portal as `https://portal.energrid.bg` while keeping
the Pi behind the home router.

## Recommended Shape

Start with one public hostname:

```text
portal.energrid.bg
```

On the Pi, nginx should serve the built portal and proxy only the routes the
portal currently needs:

```text
/                  -> /var/www/energrid/dist/apps/portal
/auth              -> http://127.0.0.1:3000
/portal            -> http://127.0.0.1:3000
/voice             -> http://127.0.0.1:3000, WebSocket enabled
```

This keeps the browser on one origin. The portal can call `/portal/state`,
`/voice/config`, `/auth/login`, and `wss://portal.energrid.bg/voice` without
CORS pain or LAN IPs.

## What Stays Private For Now

Keep these local until we intentionally add public auth and routing:

```text
core service       -> http://127.0.0.1:3102/core
API docs           -> http://127.0.0.1:3000/api/docs
panel endpoints    -> http://127.0.0.1:3000/panel
voice debug socket -> ws://127.0.0.1:3000/voice-debug
```

The portal can later reach core through the main API, or we can expose a small
authenticated `/core` route once the customer-facing security boundary is clear.

## Pi Services

The current production services should be:

```text
energrid-api.service  -> node /var/www/energrid/dist/api/main.js, port 3000
nginx                 -> local HTTP entrypoint, port 80
cloudflared           -> public HTTPS tunnel from Cloudflare to nginx
```

The core app can run privately when needed:

```text
energrid-core.service -> node /var/www/energrid/dist/apps/core/main.js, port 3102
```

## Application Releases

Use the versioned deployment procedure in [One-command Pi deployment](one-command-pi-deployment.md).
The Pi runs the API and Core as systemd services and serves the static Portal
through Nginx. Mosquitto is separate and is not restarted by application
releases. Do not build directly in a live service directory or run database
migrations as part of an application deployment.

## Install Nginx Config

```sh
sudo cp deploy/nginx/energrid-portal.conf /etc/nginx/sites-available/energrid-portal.conf
sudo ln -sf /etc/nginx/sites-available/energrid-portal.conf /etc/nginx/sites-enabled/energrid-portal.conf
sudo nginx -t
sudo systemctl reload nginx
```

Local Pi checks:

```sh
curl http://localhost/voice/config
curl http://localhost/portal/state
```

## Cloudflare Tunnel

The tunnel should point the hostname to nginx:

```text
portal.energrid.bg -> http://localhost:80
```

After that, the browser should use:

```text
https://portal.energrid.bg
```

The voice socket should resolve to:

```text
wss://portal.energrid.bg/voice
```

## Notes

- Do not expose raw port `3000` publicly.
- Keep OpenAI and local Whisper environment values in systemd environment files,
  not in the portal build.
- Cloudflare gives the browser HTTPS, which also fixes microphone permission
  issues for non-localhost access.
