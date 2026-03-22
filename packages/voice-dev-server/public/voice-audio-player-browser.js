window.createVoiceAudioPlayerBrowser = function createVoiceAudioPlayerBrowser({
  onPlaybackStart,
  onPlaybackEnd,
  log,
}) {
  let queue = []
  let isPlaying = false
  let visibleAudio = null
  let visibleContainer = null

  function ensureVisiblePlayer(messageRef) {
    if (!messageRef) return null
    if (visibleAudio && visibleContainer === messageRef.wrapper) {
      return visibleAudio
    }

    const audio = document.createElement('audio')
    audio.controls = true
    audio.preload = 'auto'
    messageRef.wrapper.appendChild(audio)

    visibleAudio = audio
    visibleContainer = messageRef.wrapper

    return visibleAudio
  }

  function base64ToBlobUrl(base64Audio) {
    const binary = atob(base64Audio)
    const bytes = new Uint8Array(binary.length)

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }

    const blob = new Blob([bytes], { type: 'audio/wav' })
    return URL.createObjectURL(blob)
  }

  function playNext() {
    if (isPlaying) return
    if (!queue.length) return

    const item = queue.shift()
    const audio = ensureVisiblePlayer(item.messageRef)
    if (!audio) return

    isPlaying = true
    const url = base64ToBlobUrl(item.base64Audio)

    audio.src = url
    audio.currentTime = 0

    audio.onplay = () => {
      log(
        `[voice] assistant audio chunk playback started index=${item.chunkIndex} last=${item.isLastChunk}`,
      )
      onPlaybackStart?.()
    }

    audio.onended = () => {
      URL.revokeObjectURL(url)
      isPlaying = false

      log(
        `[voice] assistant audio chunk playback ended index=${item.chunkIndex} last=${item.isLastChunk}`,
      )

      if (queue.length === 0) {
        onPlaybackEnd?.()
      }

      playNext()
    }

    audio.onpause = () => {
      // ignore manual pause for now
    }

    audio.onerror = () => {
      URL.revokeObjectURL(url)
      isPlaying = false
      log(
        `[voice] assistant audio chunk playback error index=${item.chunkIndex} last=${item.isLastChunk}`,
      )

      if (queue.length === 0) {
        onPlaybackEnd?.()
      }

      playNext()
    }

    audio.play().catch((error) => {
      URL.revokeObjectURL(url)
      isPlaying = false
      log(`[voice] assistant audio play() failed: ${String(error)}`)
      if (queue.length === 0) {
        onPlaybackEnd?.()
      }
      playNext()
    })
  }

  function enqueue(messageRef, base64Audio, chunkIndex, isLastChunk) {
    if (!messageRef || !base64Audio) return
    queue.push({
      messageRef,
      base64Audio,
      chunkIndex,
      isLastChunk,
    })
    playNext()
  }

  function clear() {
    queue = []
    isPlaying = false
    visibleAudio = null
    visibleContainer = null
  }

  return {
    enqueue,
    clear,
  }
}
