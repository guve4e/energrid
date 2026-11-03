/** One audio chunk owns one object URL; release it after playback or failure. */
export function playAudioBase64(base64: string, format = 'wav') {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: `audio/${format}` });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const release = () => URL.revokeObjectURL(url);
  audio.addEventListener('ended', release, { once: true });
  audio.addEventListener('error', release, { once: true });
  void audio.play().catch(release);
}
