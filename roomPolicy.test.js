const assert = require('assert');
const { canJoinRoom, MAX_ROOM_PEERS } = require('./roomPolicy');

assert.strictEqual(MAX_ROOM_PEERS, 2);
assert.strictEqual(canJoinRoom(0), true);
assert.strictEqual(canJoinRoom(1), true);
assert.strictEqual(canJoinRoom(2), false);
assert.strictEqual(canJoinRoom(3), false);

console.log('roomPolicy tests passed');
