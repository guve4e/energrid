window.createVoiceAudioPlayerBrowser = function createVoiceAudioPlayerBrowser({
                                                                                onPlaybackStart,
                                                                                onPlaybackEnd,
                                                                                log,
                                                                              }) {
  let queue = []
  let isPlaying = false
  let activeObjectUrl = null
  let visibleAudio = null
  let visibleContainer = null
  let playbackStarted = false

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
    playbackStarted = false

    cleanupActiveObjectUrl()
    resetVisiblePlayer()
  }

  function playNext() {
    if (isPlaying) return
    if (!queue.length) {
      finalizePlaybackIfNeeded()
      return
    }

    const item = queue.shift()
    const audio = ensureVisiblePlayer(item.messageRef)

    if (!audio) {
      finalizePlaybackIfNeeded()
      return
    }

    const url = createBlobUrl(item.base64Audio)
    if (!url) {
      finalizePlaybackIfNeeded()
      return
    }

    isPlaying = true
    activeObjectUrl = url

    bindAudioHandlers(audio, item, url)

    audio.src = url
    audio.currentTime = 0

    const playPromise = audio.play()
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((error) => {
        handlePlaybackFailure(item, error)
      })
    }
  }

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

  function bindAudioHandlers(audio, item, url) {
    audio.onplay = () => {
      if (!playbackStarted) {
        playbackStarted = true
        onPlaybackStart?.()
      }

      log(
        `[voice] assistant audio chunk playback started index=${item.chunkIndex} last=${item.isLastChunk}`,
      )
    }

    audio.onended = () => {
      log(
        `[voice] assistant audio chunk playback ended index=${item.chunkIndex} last=${item.isLastChunk}`,
      )

      finishCurrentChunk()
      playNext()
    }

    audio.onerror = () => {
      log(
        `[voice] assistant audio chunk playback error index=${item.chunkIndex} last=${item.isLastChunk}`,
      )

      finishCurrentChunk()
      playNext()
    }

    audio.onpause = () => {
      // ignored for now
    }
  }

  function finishCurrentChunk() {
    isPlaying = false
    cleanupActiveObjectUrl()
  }

  function handlePlaybackFailure(item, error) {
    log(`[voice] assistant audio play() failed: ${String(error)}`)
    log(
      `[voice] assistant audio chunk playback error index=${item.chunkIndex} last=${item.isLastChunk}`,
    )

    finishCurrentChunk()
    playNext()
  }

  function finalizePlaybackIfNeeded() {
    if (!playbackStarted) return
    if (isPlaying) return
    if (queue.length) return

    playbackStarted = false
    onPlaybackEnd?.()
  }

  function createBlobUrl(base64Audio) {
    try {
      const binary = atob(base64Audio)
      const bytes = new Uint8Array(binary.length)

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }

      const blob = new Blob([bytes], { type: 'audio/wav' })
      return URL.createObjectURL(blob)
    } catch (error) {
      log(`[voice] failed to create audio blob url: ${String(error)}`)
      return null
    }
  }

  function cleanupActiveObjectUrl() {
    if (!activeObjectUrl) return
    URL.revokeObjectURL(activeObjectUrl)
    activeObjectUrl = null
  }

  function resetVisiblePlayer() {
    if (visibleAudio) {
      visibleAudio.pause()
      visibleAudio.removeAttribute('src')
      visibleAudio.load()
    }

    visibleAudio = null
    visibleContainer = null
  }

  return {
    enqueue,
    clear,
  }
}
