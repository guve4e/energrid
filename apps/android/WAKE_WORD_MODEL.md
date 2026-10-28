# Offline Energrid wake word

## Selected path

Use the Android port of openWakeWord with a project-owned custom classifier for
the brand name Energrid, spoken naturally by the user in Bulgarian. “Енергрид”
is only a phonetic spelling in the UI/docs; the detector learns the sound, not
whether the name is a dictionary word. It runs its full audio feature pipeline on-device:
16 kHz mono PCM -> mel spectrogram -> shared speech embedding -> small wake-word
classifier. The Android port documents API 26+, custom ONNX models, and a
`[1, 16, 96]` input / `[1, 1]` output contract. Its reported shared preprocessing
assets total about 2.4 MB; custom classifier size depends on training, and the
port's built-in classifiers are under 1.3 MB each. No speech-recognition model
or audio-to-server wake stream is needed.

The app expects one classifier file at:

`/data/data/bg.energrid.home/files/wakeword-energrid.onnx`

The app intentionally does not ship an unrelated English model. Until the
custom file is installed, enabling wake detection reports `model_missing` and
does not open the microphone. The sample recorder is separate and only opens
the microphone after the user explicitly starts a sample.

## Training data to collect

On the tablet's Assistant page, use **Train “Енергрид”**:

- Select **Wake phrase**, tap **Record sample**, say only “Energrid” the way
  you naturally address it in Bulgarian once, then tap **Stop recording**.
  Positive clips auto-stop at 8 seconds.
- Collect 40-60 positive clips. Vary distance (near/far), volume, and room
  position. Keep each clip to one utterance; do not say it in the same rhythm
  every time.
- For longer negative/background audio, select one category: **Bulgarian TV /
  YouTube**, **Ordinary conversation**, **Household sounds**, or **Mixed
  background**, then tap **Start background session**. Let it record while that
  sound is naturally present, then tap **Stop recording**. It writes local
  five-minute WAV parts and can continue until stopped; no audio is uploaded.
- Every part from one uninterrupted capture has the same `session_id` in
  `background_manifest.csv`. Positive clips recorded on the same local date
  share a `session_id` in `positive_manifest.csv`. Keep every sample from a
  session together in training, validation, or test; never split a session
  across sets. Do not record private conversation you do not want in the
  exported ZIP.
- Collect several independent sessions in each relevant category, preferably
  at different times and with different content/room conditions. Capture a
  genuinely new set of sessions specifically for final testing and do not use
  those sessions to tune the model or threshold.
- Tap **Share samples** to export the labeled WAV files in a ZIP. Samples stay
  in app-private storage unless explicitly shared. They are 16 kHz, mono,
  signed 16-bit PCM WAV. The ZIP includes session manifests. The original 60
  positive and 31 negative recordings remain untouched; new background
  sessions are added separately. The original recordings predate session
  manifests, so conservatively keep them in one group unless their source
  session provenance can be established independently.

This provides real pronunciation and target-microphone examples. Training must
also create varied synthetic positives and hard negatives, then evaluate on
held-out real recordings. Split by `session_id` (and keep the original clips
grouped by their source recording session where known), not by WAV filename.
The untouched test sessions must not be used for threshold tuning. A model
should not be shipped based only on its training score. If training data cannot
reliably synthesize the Bulgarian pronunciation, collect additional speakers
saying the exact phrase instead of using a model that only recognizes unrelated
English pronunciations.

## Training environment status

The upstream openWakeWord trainer has been installed in the isolated temporary
Python 3.12 environment at `/private/tmp/energrid-openwakeword-trainer-venv`,
from the upstream source checkout at
`/private/tmp/energrid-openwakeword-upstream` (revision `368c037`, openWakeWord
0.6.0). Its trainer imports and its CLI help runs successfully. Key installed
versions include PyTorch/torchaudio 2.5.1, NumPy 2.4.1, SciPy 1.15.3,
audiomentations 0.43.1, and torchmetrics 0.11.4. This is a prepared feasibility
environment only: no synthetic samples or model have been generated, and no
training has been run. The temporary environment is local to this development
machine and is not packaged into the Android app.

The upstream sample generator's default Piper checkpoint is English and must
not be used to synthesize “Енергрид”. A Bulgarian Piper ONNX voice is not the
PyTorch checkpoint expected by that upstream generator; Bulgarian synthetic
positive generation therefore still needs a compatible voice/checkpoint or a
small adapter that emits audio accepted by the official trainer. Do not proceed
to training until this gap and the session-level split manifest are resolved.

## Validation on the Galaxy Tab S5e

1. Confirm the classifier input/output tensors match the contract above and
   install the model in app-private files as `wakeword-energrid.onnx`.
2. Enable Wake word on. Confirm Android log tag `EnergridWakeWord` reports the
   detector listening and that airplane mode does not change recognition.
3. Try at least 50 intended activations across near/far positions, normal and
   quiet speech, and ordinary room noise; record misses.
4. Play or speak at least 2 hours of ordinary Bulgarian speech and ambient
   sound without the phrase; record every false activation.
5. Tune threshold on validation clips, then rerun the final evaluation on a
   separate held-out set. Verify each true activation enters the existing
   Assistant flow once, the detector pauses during the assistant turn, resumes
   afterward, and no wake audio is sent to the backend.
6. Measure idle CPU, memory, battery, and tablet temperature during a 30-minute
   dashboard session with wake detection enabled. Confirm the app stays
   fullscreen and responsive.

## Alternatives and licensing

- **Porcupine:** the quickest custom-model authoring experience and its Android
  runtime is designed for low-power local detection. The official model API
  currently lists English, French, German, Italian, Japanese, Korean, Mandarin,
  Portuguese, and Spanish, but not Bulgarian. Typing the brand name into an
  English model is not evidence it will detect the natural Bulgarian
  pronunciation. Requires a Picovoice access key; licensing beyond evaluation
  must be checked for the intended deployment.
- **microWakeWord:** Apache-2.0 training/runtime project, very small streaming
  quantized TFLite models and low-power-oriented architecture. Its documented
  preprocessing/runtime is TFLite Micro and training is explicitly advanced;
  the repository points to an embedded-device pipeline rather than a ready
  Android integration. It is a possible later footprint optimization, but
  integrating and validating its feature frontend on this tablet is more work.
- **openWakeWord:** Apache-2.0 engine code and an existing Android/ONNX port;
  best implementation path for this Android app. Do not bundle its example
  pretrained phrase classifiers: upstream marks them CC BY-NC-SA 4.0. The
  shared embedding model is based on Google's Apache-2.0 speech embedding.
  Confirm the license/provenance of all exact preprocessing and custom model
  artifacts before any commercial redistribution; upstream issue discussions
  show this has needed clarification. Train only our own classifier and retain
  a model/data provenance record.
- **Tiny custom TFLite/ONNX classifier from scratch:** smallest possible
  packaged model, but needs a feature extractor, training pipeline, and much
  more validation work than reusing openWakeWord's compatible pipeline.

References: [openWakeWord Android port](https://github.com/msnilsen/openwakeword-android),
[openWakeWord training and model architecture](https://github.com/dscripka/openWakeWord),
[microWakeWord](https://github.com/OHF-Voice/micro-wake-word), and
[Porcupine supported languages](https://picovoice.ai/docs/faq/porcupine/).
