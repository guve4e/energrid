window.createVoiceVadBrowser = function createVoiceVadBrowser({
                                                                config,
                                                                log,
                                                                onSpeechStart,
                                                                onSpeechEnd,
                                                                onMisfire,
                                                              }) {
  let vadInstance = null

  async function ensureCreated() {
    if (vadInstance) {
      return vadInstance
    }

    log('[vad] creating MicVAD instance')

    vadInstance = await vad.MicVAD.new({
      onnxWASMBasePath: config.VAD_ONNX_WASM_BASE_PATH,
      baseAssetPath: config.VAD_BASE_ASSET_PATH,

      onSpeechStart: () => {
        log('[vad] speech start detected')
        onSpeechStart?.()
      },

      onSpeechEnd: (audio) => {
        log(`[vad] speech end detected samples=${audio.length}`)
        onSpeechEnd?.(audio)
      },

      onVADMisfire: () => {
        log('[vad] misfire detected')
        onMisfire?.()
      },
    })

    log('[vad] MicVAD ready')
    return vadInstance
  }

  async function start() {
    const instance = await ensureCreated()
    await instance.start()
  }

  async function pause() {
    if (!vadInstance) return
    await vadInstance.pause()
  }

  async function destroy() {
    if (!vadInstance) return

    try {
      await vadInstance.pause()
    } catch (_) {
      // ignore
    }

    vadInstance = null
  }

  return {
    ensureCreated,
    start,
    pause,
    destroy,
  }
}
