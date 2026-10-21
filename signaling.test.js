const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createSignalingServer } = require('./index');
const once = (s, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out: ${event}`)), 2500);
  s.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});

test('two-person rooms, isolation, reconnect, chat identity and malformed payloads', async () => {
  const { server, io: signaling } = createSignalingServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  const connect = async () => {
    const s = io(`http://127.0.0.1:${server.address().port}`, { transports: ['polling'], forceNew: true });
    sockets.push(s); await once(s, 'connect'); return s;
  };
  const join = async (s, room, name, sessionId) => {
    const accepted = once(s, 'room-joined'); s.emit('join-room', { roomId: room, name, sessionId }); return accepted;
  };
  try {
    const a = await connect(), b = await connect(), c = await connect();
    await join(a, 'PAIR', 'A');
    const ready = once(a, 'peer-ready');
    await join(b, 'PAIR', 'B', 'test-session-12345678'); await ready;
    assert.equal((await join(b, 'PAIR', 'B')).users.length, 2, 'duplicate joins are idempotent');
    const full = once(c, 'room-full'); c.emit('join-room', { roomId: 'PAIR', name: 'C' }); await full;
    await join(c, 'OTHER', 'C');
    let intrusion = false;
    c.on('offer', () => { intrusion = true; });
    a.emit('offer', { roomId: 'OTHER', to: c.id, offer: { type: 'offer', sdp: 'forbidden' } });
    a.emit('offer', { roomId: 'PAIR', to: c.id, offer: { type: 'offer', sdp: 'forbidden' } });
    a.emit('join-room', null); a.emit('chat-message', null); a.emit('offer', null);
    const offer = once(b, 'offer');
    a.emit('offer', { roomId: 'PAIR', to: b.id, offer: { type: 'offer', sdp: 'valid' } });
    assert.equal((await offer).offer.sdp, 'valid');
    const chat = once(b, 'chat-message');
    a.emit('chat-message', { roomId: 'OTHER', author: 'Spoof', text: 'Hello' });
    assert.equal((await chat).author, 'A', 'server owns sender identity and room');
    const recovery = once(a, 'restart-ice'); b.emit('recover-call');
    assert.equal((await recovery).peerId, b.id);
    const resumed = await connect();
    const replaced = once(a, 'peer-left'); const replacedId = b.id;
    assert.equal((await join(resumed, 'PAIR', 'B', 'test-session-12345678')).users.length, 2);
    assert.equal((await replaced).peerId, replacedId);
    const departed = once(a, 'peer-left'); const oldId = resumed.id; resumed.disconnect();
    assert.equal((await departed).peerId, oldId);
    await join(c, 'PAIR', 'C');
    assert.equal(intrusion, false);
    const replacement = await connect();
    const rejected = once(replacement, 'room-full'); replacement.emit('join-room', { roomId: 'PAIR' }); await rejected;
  } finally {
    sockets.forEach((s) => s.disconnect());
    await new Promise((resolve) => signaling.close(resolve));
  }
});
