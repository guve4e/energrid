window.VOICE_CONFIG = {
  WS_URL: 'ws://localhost:3000/voice',

  VAD_ONNX_WASM_BASE_PATH:
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
  VAD_BASE_ASSET_PATH:
    'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/',

  PCM_SAMPLE_RATE: 16000,
  PCM_CHUNK_SAMPLES: 4096,

  ASSISTANT_PLAYBACK_GRACE_MS: 1200,
}
