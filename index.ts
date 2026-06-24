import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || true,
    credentials: true,
  },
});

interface ChatPayload {
  roomId: string;
  author: string;
  text: string;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'webrtc-signaling' });
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }: { roomId: string; name: string }) => {
    const cleanRoom = String(roomId || '').trim().slice(0, 80);
    const cleanName = String(name || 'Guest').trim().slice(0, 40);
    if (!cleanRoom) return;

    socket.data.roomId = cleanRoom;
    socket.data.name = cleanName;
    socket.join(cleanRoom);

    const room = io.sockets.adapter.rooms.get(cleanRoom);
    const users = Array.from(room || []).map((id) => ({
      id,
      name: io.sockets.sockets.get(id)?.data.name || 'Guest',
    }));

    io.to(cleanRoom).emit('room-users', users);
    socket.to(cleanRoom).emit('peer-ready', { peerId: socket.id, name: cleanName });
  });

  socket.on('offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('offer', { from: socket.id, offer });
  });

  socket.on('answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('chat-message', ({ roomId, author, text }: ChatPayload) => {
    const cleanText = String(text || '').trim().slice(0, 500);
    if (!roomId || !cleanText) return;
    io.to(roomId).emit('chat-message', {
      id: `${Date.now()}-${socket.id}`,
      author: String(author || socket.data.name || 'Guest').slice(0, 40),
      text: cleanText,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('peer-left', { peerId: socket.id });
    const room = io.sockets.adapter.rooms.get(roomId);
    const users = Array.from(room || []).map((id) => ({
      id,
      name: io.sockets.sockets.get(id)?.data.name || 'Guest',
    }));
    io.to(roomId).emit('room-users', users);
  });
});

const port = Number(process.env.PORT || 3001);
server.listen(port, () => {
  console.log(`WebRTC signaling listening on ${port}`);
});
