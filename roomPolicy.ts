export const MAX_ROOM_PEERS = 2;

export function canJoinRoom(existingPeerCount: number) {
  return existingPeerCount < MAX_ROOM_PEERS;
}
