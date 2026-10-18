export type VoiceTurnSocket = Pick<WebSocket, 'readyState' | 'close'>

export function closeCompletedTurnSocket(
  socket: VoiceTurnSocket,
  activeSocket: VoiceTurnSocket | null,
): boolean {
  if (socket !== activeSocket || socket.readyState !== WebSocket.OPEN) return false
  socket.close(1000, 'turn complete')
  return true
}
