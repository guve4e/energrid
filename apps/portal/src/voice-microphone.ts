export function microphoneSetupError(
  secureContext: boolean,
  hasGetUserMedia: boolean,
): string | null {
  if (!secureContext) {
    return 'Microphone access needs a secure page. On this computer, open the portal at localhost; on another device, use an HTTPS address.'
  }
  if (!hasGetUserMedia) {
    return 'This browser does not provide microphone capture. Try a current browser with microphone access enabled.'
  }
  return null
}

export function microphoneRequestError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission was denied. Allow microphone access for this site, then try again.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect or enable a microphone, then try again.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is busy or unavailable. Close other apps using it, then try again.'
  }
  return 'The microphone could not be started. Check browser permission and try again.'
}

export function stopMicrophoneStream(
  stream: Pick<MediaStream, 'getTracks'> | null,
): void {
  stream?.getTracks().forEach((track) => track.stop())
}
