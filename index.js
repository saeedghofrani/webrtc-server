"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server);
app.get('/', (req, res) => {
    res.send('WebRTC Server Running');
});
io.on('connection', (socket) => {
    console.log('a user connected');
    socket.on('offer', (offer) => {
        socket.broadcast.emit('offer', offer);
    });
    socket.on('answer', (answer) => {
        socket.broadcast.emit('answer', answer);
    });
    socket.on('ice-candidate', (candidate) => {
        socket.broadcast.emit('ice-candidate', candidate);
    });
    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});
server.listen(3001, () => {
    console.log('Listening on *:3001');
});
