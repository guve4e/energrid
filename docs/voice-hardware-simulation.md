# Voice Hardware Simulation

Use this while waiting for the Raspberry Pi. It simulates the future Pi audio
client by replaying a WAV file into the real `/voice` WebSocket.

## Start the API

For now, keep OpenAI STT as the default:

```sh
VOICE_STT_PROVIDER=openai pnpm nx serve api
```

## Replay a Recording

The replay file must be `16kHz`, mono, `PCM16` WAV.

```sh
pnpm voice:replay /path/to/test.wav
```

Use a different server URL:

```sh
pnpm voice:replay /path/to/test.wav --ws ws://localhost:3000/voice
```

Send without real-time pacing for quick backend checks:

```sh
pnpm voice:replay /path/to/test.wav --fast
```

## Smoke Test

After recording `samples/voice/close-command.wav`, run the smoke test while the
API is running:

```sh
pnpm voice:smoke
```

It replays the sample and fails if the turn does not produce:

- `session_start`
- `stt_final` containing `ламп`
- `home_action_plan` with `turn_on_lights`
- `command_fast_path=true`
- at least one `assistant_audio_chunk`
- `turn_end` metrics

Run the silence gate check:

```sh
pnpm voice:smoke:silence
```

It replays `samples/voice/fixtures/silence-5s.wav` and fails if the system
transcribes or speaks.

Run the small voice suite:

```sh
pnpm voice:smoke:suite
```

It currently checks the main command, a quiet variant, and silence. Keep adding
clips here as we record real examples.

## Replay Assertions

`pnpm voice:replay` can now assert voice-specific behavior:

```sh
pnpm voice:replay samples/voice/close-command.wav \
  --expect-transcript ламп \
  --expect-home-intent turn_on_lights \
  --require-fast-path \
  --require-audio \
  --require-metrics
```

Useful assertion flags:

- `--expect-transcript <text>`
- `--expect-reply <text>`
- `--expect-home-intent <intent>`
- `--require-audio`
- `--forbid-audio`
- `--require-metrics`
- `--require-fast-path`
- `--forbid-transcript`

## Generate Edge Fixtures

Create repeatable edge-case WAVs from the known-good close command:

```sh
pnpm voice:fixtures
```

This writes files under `samples/voice/fixtures`, including quieter, louder,
noisy, clipped, silence-padded, and silent variants. Use them to compare STT
accuracy and latency under controlled conditions.

## Useful Test Clips

Record and keep a small set of repeatable clips:

- close Bulgarian command
- 1 meter Bulgarian command
- 3 meter Bulgarian command
- quiet speech
- loud/clipped speech
- command while background audio is playing
- non-command speech
- silence / room noise

These files let us tune VAD, latency, transcript quality, and assistant timing
without waiting on hardware.

## Pi Contract

The eventual Pi client should match the same contract:

- connect to `ws://<api-host>:3000/voice`
- send 16kHz mono PCM16 binary chunks
- send `{ "type": "end_of_turn" }` after VAD says the user stopped speaking
- receive `stt_final`, `assistant_text_delta`, `assistant_audio_chunk`, and
  `turn_end`

## Browser Client

The API also serves a tiny browser client at:

```text
http://localhost:3000/voice/client
```

When the API runs on the Pi, open:

```text
http://<pi-host-or-ip>:3000/voice/client
```

Browser microphone access from another machine usually requires HTTPS. See
`docs/voice-pi-browser-deploy.md` before debugging the mic too hard.
