# Voice Pi Browser Deploy

Goal: run the voice API on the Raspberry Pi 5, then open a browser voice client
from another machine and talk to `ws://<pi-host>:3000/voice`.

## 1. Prepare The Pi

Install the basic runtime:

```sh
sudo apt update
sudo apt install -y git curl python3 python3-venv ffmpeg
```

Install Node and pnpm using the same versions you use locally. Then clone the
repo on the Pi and install dependencies:

```sh
pnpm install
python3 -m venv .venv
.venv/bin/pip install faster-whisper
```

Copy the needed environment values to the Pi, especially:

```sh
OPENAI_API_KEY=...
VOICE_STT_PROVIDER=local-whisper
LOCAL_WHISPER_PYTHON=.venv/bin/python
LOCAL_WHISPER_MODEL=small
LOCAL_WHISPER_LANGUAGE=bg
PORT=3000
```

## 2. Start The Voice API

For local STT on the Pi:

```sh
pnpm api:voice:local
```

For OpenAI STT comparison:

```sh
pnpm api:voice:openai
```

From your Mac, confirm the Pi is reachable:

```sh
curl http://<pi-host-or-ip>:3000/voice/config
```

## 3. Browser Client

Open:

```text
http://<pi-host-or-ip>:3000/voice/client
```

The page defaults to:

```text
ws://<same-host>:3000/voice
```

Use **Hold To Talk**, speak, then release. The page shows transcript, assistant
reply, action plan, metrics, and plays returned audio chunks.

## Important Browser Mic Note

Browsers normally allow microphone access only on secure origins:

- `localhost`
- HTTPS pages

So this may work when opened directly on the Pi as `http://localhost:3000`, but
may be blocked from your Mac at `http://<pi-ip>:3000`.

For real testing from your Mac browser to the Pi, use one of these:

- put HTTPS in front of the Pi API
- use a tunnel with HTTPS
- temporarily use browser developer flags for insecure local origins

The API WebSocket itself can run over `ws://` on the LAN, but the page that
captures the microphone is what needs browser permission.

## 4. Smoke From Mac Against Pi

The replay harness can target the Pi even before the browser mic is working:

```sh
VOICE_WS_URL=ws://<pi-host-or-ip>:3000/voice pnpm voice:smoke:suite
```

This confirms the Pi API, STT, voice action plan, TTS, and metrics path.

## 5. What To Measure

For each run, watch:

- `stt`: local Whisper speed on Pi
- `first_tts`: first speech chunk generation
- `tts_total`: total speech synthesis time
- `command_fast_path=true`: confirms the automation voice shortcut is active
- `audio gate`: confirms silence/noise handling

