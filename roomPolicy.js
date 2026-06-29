"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ROOM_PEERS = void 0;
exports.canJoinRoom = canJoinRoom;
exports.MAX_ROOM_PEERS = 2;
function canJoinRoom(existingPeerCount) {
    return existingPeerCount < exports.MAX_ROOM_PEERS;
}
