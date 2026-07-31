# Voice Local STT

The voice API can transcribe each VAD-bounded user turn with either OpenAI
transcription or a local faster-whisper model.

OpenAI is the default. Local Whisper is opt-in, so the app remains usable while
the custom model is still being trained.

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
- `LOCAL_WHISPER_FALLBACK_TO_OPENAI=true` falls back to OpenAI when the local
  model returns no text

## Latency Shape

The browser still captures a short utterance with VAD and sends that finished
turn to the API. The conversational speedup comes from removing the network
round-trip for STT and from streaming the assistant response/TTS chunks as soon
as enough reply text is speakable.

## Local Benchmark

Check the local model directly, without starting the API:

```sh
pnpm voice:stt:check
```

Run the small fixture benchmark:

```sh
pnpm voice:stt:bench
```

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
