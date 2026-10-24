# Voice Processing

The current voice API captures a VAD-bounded turn, applies a server-side audio
gate, and transcribes it with OpenAI batch transcription or local faster-whisper
by default. An opt-in OpenAI Realtime streaming transcription path is also
available for incremental transcription.

Speech application services depend on provider ports in `domain-voice`. The API
module selects OpenAI batch STT or local Whisper at composition time, and keeps
the optional streaming provider behind a separate port. OpenAI TTS uses the same
adapter boundary; session logic does not depend on a provider SDK.

OpenAI batch transcription is the default. Local Whisper is opt-in, so the app
remains usable while the custom model is still being trained. Streaming STT is
also opt-in and uses OpenAI Realtime; it sends audio to OpenAI while the user is
speaking and may incur API usage charges.

## Streaming STT

Buffered turn-based transcription remains the default. To opt into streaming:

```sh
VOICE_STT_MODE=streaming \
VOICE_STT_STREAM_PROVIDER=openai \
VOICE_AUDIO_SAMPLE_RATE_HZ=16000 \
pnpm nx serve api
```

The browser currently sends mono PCM16 at 16 kHz. The OpenAI adapter resamples
it incrementally to the 24 kHz PCM16 format required by Realtime transcription,
then sends audio as it arrives after the server-side speech gate opens. Final
transcription still waits for the end-of-turn signal. The OpenAI API key is read
from the API process environment; do not put it in browser configuration.

`OPENAI_STT_STREAM_MODEL` defaults to `gpt-live-transcribe`. The adapter uses
the GA Realtime WebSocket endpoint without the retired beta header and selects
transcription intent in the WebSocket handshake; the selected model stays in
the session configuration. It sends the model-specific language configuration
(`languages` for `gpt-live-transcribe`). You can still override the model with
a compatible transcription model. `OPENAI_STT_STREAM_CONNECT_TIMEOUT_MS`
defaults to 10 seconds. Startup waits for OpenAI's session acknowledgement
before audio is sent; rejected configurations are logged with sanitized
provider event/code/field details. The `/voice/config` endpoint reports the
active mode and selected model/provider.

## Access And Privacy

WebSocket clients must send an initial JSON message containing a short-lived
access JWT from an authenticated account session before the server creates a
voice session. For CLI replay, set `AUTH_ADMIN_EMAIL`, `AUTH_ADMIN_PASSWORD`,
and (when required) `AUTH_CLIENT_ORIGIN` in the private environment; the tool
logs in, uses a short-lived access JWT, then revokes its session:

```json
{"type":"authenticate","token":"<short-lived access JWT>"}
```

Use TLS/WSS outside localhost. Voice debug sockets are disabled unless
`VOICE_DEBUG_ENABLED=true` and require an administrator access JWT. Voice run persistence and
file tracing are opt-in (`VOICE_RUNS_ENABLED=true` and
`VOICE_TRACE_ENABLED=true`). Persisted transcripts contain household data, so
enable them only for deliberate diagnostics and apply an explicit retention
policy.

Provider calls have bounded 30-second defaults. `VOICE_STT_TIMEOUT_MS`,
`VOICE_TTS_TIMEOUT_MS`, and `LOCAL_WHISPER_TIMEOUT_MS` can tune them from 1 to
120 seconds. SDK retries are disabled for STT/TTS calls to avoid hidden repeat
requests and unpredictable turn latency. OpenAI remains the default cloud
provider; local Whisper does not send audio to OpenAI unless the explicit
`LOCAL_WHISPER_FALLBACK_TO_OPENAI=true` option is enabled.

Voice-driven device actions are shown in the portal and require a deliberate
**Confirm action** click. The server keeps the generated plan on the authenticated
socket, issues a one-time approval ID, and expires it after
`VOICE_ACTION_APPROVAL_MS` (15 seconds by default, bounded to 5–60 seconds). The
browser cannot submit or alter the device plan. Cancel, expiry, disconnect, and
replay do not execute the action. Other voice clients without the confirmation
UI remain fail-closed.
The audio turn size defaults to 1.536 MB (about 48 seconds of mono 16 kHz
PCM16); `VOICE_MAX_AUDIO_BYTES` may tune it within the server-enforced bounds.

## OpenAI STT

Start the API without `VOICE_STT_PROVIDER`, or set it explicitly:

```sh
VOICE_STT_PROVIDER=openai pnpm nx serve api
```

The OpenAI transcription model defaults to `gpt-4o-transcribe`. Override it
with:

```sh
BATCH_STT_MODEL=gpt-4o-mini-transcribe pnpm nx serve api
```

## Runtime

Install the Python dependency in the environment that runs the API:

```sh
python3 -m venv .venv
.venv/bin/pip install faster-whisper
```

Then start the API with:

```sh
pnpm api:voice:local
```

By default the helper uses the `small` Whisper model on CPU with `int8`
compute. For a Colab-trained/exported model, point the API at the exported
model directory:

```sh
VOICE_STT_PROVIDER=local-whisper \
LOCAL_WHISPER_MODEL_PATH=/path/to/exported/model \
LOCAL_WHISPER_LANGUAGE=bg \
LOCAL_WHISPER_PYTHON=.venv/bin/python \
pnpm nx serve api
```

Useful knobs:

- `LOCAL_WHISPER_MODEL` defaults to `small`
- `LOCAL_WHISPER_MODEL_PATH` overrides `LOCAL_WHISPER_MODEL`
- `LOCAL_WHISPER_DEVICE` defaults to `cpu`
- `LOCAL_WHISPER_COMPUTE_TYPE` defaults to `int8`
- `LOCAL_WHISPER_LANGUAGE` defaults to `bg`
- `LOCAL_WHISPER_TIMEOUT_MS` defaults to `30000`
- `LOCAL_WHISPER_PYTHON` defaults to `python3`
- `LOCAL_WHISPER_SCRIPT` can point to a custom transcription script
- `LOCAL_WHISPER_WORKER` defaults to enabled; set `false` for one-shot Python
- `LOCAL_WHISPER_WORKER_SCRIPT` can point to a custom long-running worker
- `LOCAL_WHISPER_FALLBACK_TO_OPENAI=true` falls back to OpenAI when the local
  model returns no text

## Latency Shape

The browser captures a short utterance with VAD. In buffered mode it sends the
finished turn for transcription; in streaming mode it sends gated PCM chunks as
the user speaks. The conversational speedup also comes from streaming assistant
response/TTS chunks as soon as enough reply text is speakable.

## Local Benchmark

Check the local model directly, without starting the API:

```sh
pnpm voice:stt:check
```

Run the small fixture benchmark:

```sh
pnpm voice:stt:bench
```

Run the persistent-worker benchmark:

```sh
pnpm voice:stt:worker
```

The worker benchmark starts Python once, loads the model once, then sends each
fixture to the same process. This is the mode the API uses by default for
`VOICE_STT_PROVIDER=local-whisper`.

On this Mac with `small`, `cpu`, and `int8`, the first run took about `80s`
because the model had to download/load cold. Warm runs then transcribed the
main command in about `2.3s`.

Recent warm fixture results:

- `close-command.wav`: `2333ms`, correct
- `close-command-quiet.wav`: `2132ms`, correct
- `close-command-noisy.wav`: `2005ms`, mistranscribed as noisy input
- `close-command-leading-trailing-silence.wav`: `2078ms`, correct

To test the full voice socket through local STT:

```sh
pnpm api:voice:local
```

In another terminal:

```sh
pnpm voice:smoke:suite
```

Compare against OpenAI STT by restarting the API with:

```sh
pnpm api:voice:openai
```
