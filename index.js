"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: ((_a = process.env.CORS_ORIGIN) === null || _a === void 0 ? void 0 : _a.split(',')) || true,
        credentials: true,
    },
});
app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'webrtc-signaling' });
});
io.on('connection', (socket) => {
    console.log(`socket connected ${socket.id}`);
    socket.on('join-room', ({ roomId, name }) => {
        const cleanRoom = String(roomId || '').trim().slice(0, 80);
        const cleanName = String(name || 'Guest').trim().slice(0, 40);
        if (!cleanRoom)
            return;
        const existingPeers = Array.from(io.sockets.adapter.rooms.get(cleanRoom) || []);
        socket.data.roomId = cleanRoom;
        socket.data.name = cleanName;
        socket.join(cleanRoom);
        console.log(`socket ${socket.id} joined ${cleanRoom}; existing peers: ${existingPeers.length}`);
        const room = io.sockets.adapter.rooms.get(cleanRoom);
        const users = Array.from(room || []).map((id) => {
            var _a;
            return ({
                id,
                name: ((_a = io.sockets.sockets.get(id)) === null || _a === void 0 ? void 0 : _a.data.name) || 'Guest',
            });
        });
        io.to(cleanRoom).emit('room-users', users);
        existingPeers.forEach((peerId) => {
            socket.to(peerId).emit('peer-ready', { peerId: socket.id, name: cleanName });
        });
    });
    socket.on('offer', ({ roomId, to, offer }) => {
        console.log(`offer ${socket.id} -> ${to || roomId}`);
        if (to) {
            socket.to(to).emit('offer', { from: socket.id, roomId, offer });
            return;
        }
        socket.to(roomId).emit('offer', { from: socket.id, roomId, offer });
    });
    socket.on('answer', ({ roomId, to, answer }) => {
        console.log(`answer ${socket.id} -> ${to || roomId}`);
        if (to) {
            socket.to(to).emit('answer', { from: socket.id, roomId, answer });
            return;
        }
        socket.to(roomId).emit('answer', { from: socket.id, roomId, answer });
    });
    socket.on('ice-candidate', ({ roomId, to, candidate }) => {
        console.log(`ice-candidate ${socket.id} -> ${to || roomId}`);
        if (to) {
            socket.to(to).emit('ice-candidate', { from: socket.id, roomId, candidate });
            return;
        }
        socket.to(roomId).emit('ice-candidate', { from: socket.id, roomId, candidate });
    });
    socket.on('chat-message', ({ roomId, author, text }) => {
        const cleanText = String(text || '').trim().slice(0, 500);
        if (!roomId || !cleanText)
            return;
        io.to(roomId).emit('chat-message', {
            id: `${Date.now()}-${socket.id}`,
            author: String(author || socket.data.name || 'Guest').slice(0, 40),
            text: cleanText,
            createdAt: new Date().toISOString(),
        });
    });
    socket.on('disconnect', () => {
        console.log(`socket disconnected ${socket.id}`);
        const roomId = socket.data.roomId;
        if (!roomId)
            return;
        socket.to(roomId).emit('peer-left', { peerId: socket.id });
        const room = io.sockets.adapter.rooms.get(roomId);
        const users = Array.from(room || []).map((id) => {
            var _a;
            return ({
                id,
                name: ((_a = io.sockets.sockets.get(id)) === null || _a === void 0 ? void 0 : _a.data.name) || 'Guest',
            });
        });
        io.to(roomId).emit('room-users', users);
    });
});
const port = Number(process.env.PORT || 3001);
server.listen(port, () => {
    console.log(`WebRTC signaling listening on ${port}`);
});
