"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignalingServer = createSignalingServer;
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const crypto_1 = require("crypto");
const net_1 = require("net");
const socket_io_1 = require("socket.io");
const roomPolicy_1 = require("./roomPolicy");
const callLinks_1 = require("./callLinks");
function createSignalingServer(options = {}) {
    var _a;
    const app = (0, express_1.default)();
    // Host Nginx reaches a published Docker port through the bridge gateway.
    // Accept only explicitly configured proxy IPs, never a whole private subnet.
    const proxyIps = (process.env.TRUSTED_PROXY_IPS || '').split(',').map((ip) => ip.trim()).filter((ip) => (0, net_1.isIP)(ip));
    app.set('trust proxy', ['loopback', ...proxyIps]);
    app.use('/api/call-links', express_1.default.json({ limit: '12kb' }), (0, callLinks_1.callLinksRouter)(options.callLinks));
    const server = http_1.default.createServer(app);
    const io = new socket_io_1.Server(server, {
        cors: { origin: ((_a = process.env.CORS_ORIGIN) === null || _a === void 0 ? void 0 : _a.split(',')) || true, credentials: true },
        maxHttpBufferSize: 100000,
    });
    const channel = (room) => `meeting:${room}`;
    const members = (room) => Array.from(io.sockets.adapter.rooms.get(channel(room)) || []);
    const users = (room) => members(room).map((id) => {
        var _a, _b;
        return (Object.assign({ id, name: ((_a = io.sockets.sockets.get(id)) === null || _a === void 0 ? void 0 : _a.data.name) || 'Guest' }, (_b = io.sockets.sockets.get(id)) === null || _b === void 0 ? void 0 : _b.data.media));
    });
    const publishUsers = (room) => io.to(channel(room)).emit('room-users', users(room));
    const leave = (socket) => {
        const room = socket.data.roomId;
        if (!room)
            return;
        socket.leave(channel(room));
        socket.to(channel(room)).emit('peer-left', { peerId: socket.id });
        delete socket.data.roomId;
        publishUsers(room);
    };
    app.get('/health', (_req, res) => res.json({ ok: true, service: 'webrtc-signaling', maxParticipants: 2 }));
    io.on('connection', (socket) => {
        socket.on('join-room', (payload) => {
            if (!payload || typeof payload.roomId !== 'string')
                return;
            const room = payload.roomId.replace(/[^a-z0-9-]/gi, '').slice(0, 24).toUpperCase();
            if (!room)
                return;
            if (socket.data.roomId === room) {
                socket.emit('room-joined', { roomId: room, users: users(room) });
                return;
            }
            const session = typeof payload.sessionId === 'string' && /^[a-z0-9-]{16,80}$/i.test(payload.sessionId) ? payload.sessionId : null;
            // A reloaded tab can resume before its old polling connection times out.
            if (session)
                for (const id of members(room)) {
                    const previous = io.sockets.sockets.get(id);
                    if (previous && previous.data.sessionId === session && previous.id !== socket.id) {
                        leave(previous);
                        previous.disconnect(true);
                    }
                }
            if (!(0, roomPolicy_1.canJoinRoom)(members(room).length)) {
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
        for (const event of ['offer', 'answer', 'ice-candidate']) {
            socket.on(event, (payload) => {
                const room = socket.data.roomId;
                if (!room || !payload || payload.roomId !== room || payload.to === socket.id)
                    return;
                if (!members(room).includes(payload.to))
                    return;
                const key = event === 'ice-candidate' ? 'candidate' : event;
                if (!payload[key] || typeof payload[key] !== 'object')
                    return;
                io.to(payload.to).emit(event, { from: socket.id, roomId: room, [key]: payload[key] });
            });
        }
        socket.on('recover-call', () => {
            const room = socket.data.roomId;
            if (!room)
                return;
            const ids = members(room);
            const now = Date.now();
            const leader = io.sockets.sockets.get(ids[0]);
            if (ids.length !== 2 || !leader || now - (leader.data.lastRecovery || 0) < 5000)
                return;
            leader.data.lastRecovery = now;
            leader.emit('restart-ice', { peerId: ids[1] });
        });
        socket.on('media-state', (payload) => {
            if (!socket.data.roomId || !payload)
                return;
            socket.data.media = { micOn: payload.micOn === true, cameraOn: payload.cameraOn === true, sharing: payload.sharing === true };
            publishUsers(socket.data.roomId);
        });
        socket.on('chat-message', (payload) => {
            const room = socket.data.roomId;
            if (!room || !payload || typeof payload.text !== 'string')
                return;
            const text = payload.text.trim().slice(0, 2000);
            if (!text || Date.now() - (socket.data.lastMessage || 0) < 250)
                return;
            socket.data.lastMessage = Date.now();
            io.to(channel(room)).emit('chat-message', {
                id: (0, crypto_1.randomUUID)(), author: socket.data.name, text, createdAt: new Date().toISOString(),
            });
        });
        socket.on('leave-room', () => leave(socket));
        socket.on('disconnect', () => leave(socket));
    });
    return { app, server, io };
}
if (require.main === module) {
    const { server } = createSignalingServer();
    server.listen(Number(process.env.PORT || 3001), () => console.log('WebRTC signaling ready'));
}
