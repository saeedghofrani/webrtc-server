import express from 'express';
import http from 'http';
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { canJoinRoom } from './roomPolicy';

export function createSignalingServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: process.env.CORS_ORIGIN?.split(',') || true, credentials: true },
    maxHttpBufferSize: 100_000,
  });
  const channel = (room: string) => `meeting:${room}`;
  const members = (room: string) => Array.from(io.sockets.adapter.rooms.get(channel(room)) || []);
  const users = (room: string) => members(room).map((id) => ({
    id, name: io.sockets.sockets.get(id)?.data.name || 'Guest',
    ...io.sockets.sockets.get(id)?.data.media,
  }));
  const publishUsers = (room: string) => io.to(channel(room)).emit('room-users', users(room));
  const leave = (socket: Socket) => {
    const room = socket.data.roomId;
    if (!room) return;
    socket.leave(channel(room));
    socket.to(channel(room)).emit('peer-left', { peerId: socket.id });
    delete socket.data.roomId;
    publishUsers(room);
  };
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'webrtc-signaling', maxParticipants: 2 }));

  io.on('connection', (socket) => {
    socket.on('join-room', (payload) => {
      if (!payload || typeof payload.roomId !== 'string') return;
      const room = payload.roomId.replace(/[^a-z0-9-]/gi, '').slice(0, 24).toUpperCase();
      if (!room) return;
      if (socket.data.roomId === room) {
        socket.emit('room-joined', { roomId: room, users: users(room) });
        return;
      }
      const session = typeof payload.sessionId === 'string' && /^[a-z0-9-]{16,80}$/i.test(payload.sessionId) ? payload.sessionId : null;
      // A reloaded tab can resume before its old polling connection times out.
      if (session) for (const id of members(room)) {
        const previous = io.sockets.sockets.get(id);
        if (previous && previous.data.sessionId === session && previous.id !== socket.id) {
          leave(previous); previous.disconnect(true);
        }
      }
      if (!canJoinRoom(members(room).length)) {
        socket.emit('room-full', { roomId: room });
        return;
      }
      leave(socket);
      const existing = members(room);
      socket.data.roomId = room;
      socket.data.sessionId = session;
      socket.data.name = String(payload.name || 'Guest').trim().slice(0, 40) || 'Guest';
      socket.data.media = { micOn: payload.micOn !== false, cameraOn: payload.cameraOn !== false, sharing: false };
      socket.join(channel(room));
      socket.emit('room-joined', { roomId: room, users: users(room) });
      publishUsers(room);
      existing.forEach((id) => io.to(id).emit('peer-ready', { peerId: socket.id, name: socket.data.name }));
    });

    // Only forward signaling to the other member of this socket's meeting.
    for (const event of ['offer', 'answer', 'ice-candidate'] as const) {
      socket.on(event, (payload) => {
        const room = socket.data.roomId;
        if (!room || !payload || payload.roomId !== room || payload.to === socket.id) return;
        if (!members(room).includes(payload.to)) return;
        const key = event === 'ice-candidate' ? 'candidate' : event;
        if (!payload[key] || typeof payload[key] !== 'object') return;
        io.to(payload.to).emit(event, { from: socket.id, roomId: room, [key]: payload[key] });
      });
    }
    socket.on('recover-call', () => {
      const room = socket.data.roomId;
      if (!room) return;
      const ids = members(room);
      const now = Date.now();
      const leader = io.sockets.sockets.get(ids[0]);
      if (ids.length !== 2 || !leader || now - (leader.data.lastRecovery || 0) < 5000) return;
      leader.data.lastRecovery = now;
      leader.emit('restart-ice', { peerId: ids[1] });
    });
    socket.on('media-state', (payload) => {
      if (!socket.data.roomId || !payload) return;
      socket.data.media = { micOn: payload.micOn === true, cameraOn: payload.cameraOn === true, sharing: payload.sharing === true };
      publishUsers(socket.data.roomId);
    });
    socket.on('chat-message', (payload) => {
      const room = socket.data.roomId;
      if (!room || !payload || typeof payload.text !== 'string') return;
      const text = payload.text.trim().slice(0, 2000);
      if (!text || Date.now() - (socket.data.lastMessage || 0) < 250) return;
      socket.data.lastMessage = Date.now();
      io.to(channel(room)).emit('chat-message', {
        id: randomUUID(), author: socket.data.name, text, createdAt: new Date().toISOString(),
      });
    });
    socket.on('leave-room', () => leave(socket));
    socket.on('disconnect', () => leave(socket));
  });
  return { server, io };
}

if (require.main === module) {
  const { server } = createSignalingServer();
  server.listen(Number(process.env.PORT || 3001), () => console.log('WebRTC signaling ready'));
}
