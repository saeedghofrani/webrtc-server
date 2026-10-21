"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.firebasePush = void 0;
exports.callLinksRouter = callLinksRouter;
const express_1 = require("express");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const app_1 = require("firebase-admin/app");
const messaging_1 = require("firebase-admin/messaging");
const secret = () => (0, crypto_1.randomBytes)(32).toString('base64url');
const hash = (value) => (0, crypto_1.createHash)('sha256').update(value).digest('hex');
const validToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const firebasePush = (token, data) => __awaiter(void 0, void 0, void 0, function* () {
    const app = (0, app_1.getApps)()[0] || (0, app_1.initializeApp)({ credential: (0, app_1.applicationDefault)() });
    yield (0, messaging_1.getMessaging)(app).send({ token, data, android: { priority: 'high', ttl: 45000, restrictedPackageName: 'xyz.saeedghofrani.meet' } });
});
exports.firebasePush = firebasePush;
// One process owns this bounded, atomically replaced file. Mount its directory on a durable volume.
function callLinksRouter(options = {}) {
    var _a;
    const router = (0, express_1.Router)();
    const file = (0, path_1.resolve)(options.file || process.env.CALL_LINK_STORE || '.data/call-links.json');
    const enabled = (_a = options.enabled) !== null && _a !== void 0 ? _a : process.env.CALL_PUSH_ENABLED === 'true';
    const push = options.push || exports.firebasePush;
    const clock = options.clock || Date.now;
    let state = {};
    try {
        state = JSON.parse((0, fs_1.readFileSync)(file, 'utf8'));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const save = () => {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(file), { recursive: true, mode: 0o700 });
        (0, fs_1.writeFileSync)(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
        (0, fs_1.renameSync)(`${file}.tmp`, file);
    };
    const budgets = new Map();
    router.use((req, res, next) => {
        const origin = req.get('Origin');
        const allowed = (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',');
        if (origin && origin !== `${req.protocol}://${req.get('Host')}` && !allowed.includes(origin)) {
            res.sendStatus(403);
            return;
        }
        if (origin) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
            res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        }
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use((req, res, next) => {
        const now = clock();
        for (const [key, value] of budgets)
            if (value.until <= now)
                budgets.delete(key);
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const budget = budgets.get(key) || { count: 0, until: now + 60000 };
        if (budgets.size >= 10000 && !budgets.has(key)) {
            res.sendStatus(429);
            return;
        }
        budgets.set(key, budget);
        if (++budget.count > 120) {
            res.sendStatus(429);
            return;
        }
        next();
    });
    router.get('/config', (_req, res) => res.json({ enabled, ringSeconds: 45 }));
    router.post('/', (_req, res) => {
        if (!enabled) {
            res.status(503).json({ error: 'Incoming calls are not configured yet.' });
            return;
        }
        if (Object.keys(state).length >= 2000) {
            res.status(503).json({ error: 'Call link capacity reached.' });
            return;
        }
        const token = secret();
        state[hash(token)] = { room: (0, crypto_1.randomBytes)(12).toString('hex').toUpperCase(), devices: [] };
        save();
        res.status(201).json({ token, room: state[hash(token)].room });
    });
    router.use('/:token', (req, res, next) => {
        if (!validToken(req.params.token) || !state[hash(req.params.token)]) {
            res.sendStatus(404);
            return;
        }
        res.locals.link = state[hash(req.params.token)];
        next();
    });
    // Management credentials contain a random verifier stored only on the recipient device.
    const authorized = (req, link) => {
        const [id, verifier] = (req.get('Authorization') || '').replace(/^Bearer /, '').split('.');
        return verifier && link.devices.find((device) => device.id === id && device.secretHash === hash(verifier));
    };
    router.get('/:token', (_req, res) => {
        const link = res.locals.link;
        res.json({ room: link.room, recipients: link.devices.length, enabled });
    });
    router.post('/:token/subscriptions', (req, res) => {
        var _a;
        const link = res.locals.link;
        if (!enabled) {
            res.sendStatus(503);
            return;
        }
        const pushToken = (_a = req.body) === null || _a === void 0 ? void 0 : _a.pushToken;
        if (typeof pushToken !== 'string' || pushToken.length < 20 || pushToken.length > 4096 || /\s/.test(pushToken)) {
            res.sendStatus(400);
            return;
        }
        const current = authorized(req, link);
        if (current) {
            current.pushToken = pushToken;
            save();
            res.json({ updated: true });
            return;
        }
        if (link.devices.some((device) => device.pushToken === pushToken)) {
            res.status(409).json({ error: 'Device already registered. Disable and enable ringing to recover.' });
            return;
        }
        if (link.devices.length >= 10) {
            res.sendStatus(409);
            return;
        }
        const verifier = secret();
        const device = { id: secret(), secretHash: hash(verifier), pushToken };
        link.devices.push(device);
        save();
        res.status(201).json({ credential: `${device.id}.${verifier}` });
    });
    router.delete('/:token/subscriptions', (req, res) => {
        const link = res.locals.link;
        const device = authorized(req, link);
        if (!device) {
            res.sendStatus(401);
            return;
        }
        link.devices = link.devices.filter((item) => item !== device);
        save();
        res.sendStatus(204);
    });
    router.post('/:token/calls', (req, res, next) => __awaiter(this, void 0, void 0, function* () {
        var _a;
        const link = res.locals.link;
        if (!enabled) {
            res.sendStatus(503);
            return;
        }
        if (!link.devices.length) {
            res.status(409).json({ error: 'The recipient must enable ringing in the Android app first.' });
            return;
        }
        if (clock() - (link.lastRing || 0) < 60000) {
            res.status(429).json({ error: 'Please wait a minute before ringing again.' });
            return;
        }
        const caller = typeof ((_a = req.body) === null || _a === void 0 ? void 0 : _a.caller) === 'string' ? req.body.caller.trim().slice(0, 40) : '';
        if (!caller) {
            res.sendStatus(400);
            return;
        }
        const call = { id: secret(), caller, expiresAt: clock() + 45000, status: 'ringing' };
        link.call = call;
        link.lastRing = clock();
        save();
        try {
            const results = yield Promise.allSettled(link.devices.map((device) => __awaiter(this, void 0, void 0, function* () {
                try {
                    yield push(device.pushToken, { type: 'incoming-call', linkToken: req.params.token, callId: call.id, caller, room: link.room, expiresAt: String(call.expiresAt) });
                }
                catch (error) {
                    if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) {
                        link.devices = link.devices.filter((item) => item !== device);
                        save();
                    }
                    throw error;
                }
            })));
            const delivered = results.filter((result) => result.status === 'fulfilled').length;
            if (push === exports.firebasePush && delivered < results.length) {
                const codes = results.flatMap((result) => {
                    var _a;
                    if (result.status !== 'rejected')
                        return [];
                    const code = String(((_a = result.reason) === null || _a === void 0 ? void 0 : _a.code) || 'unknown');
                    return /^[a-z0-9/-]{1,80}$/i.test(code) ? [code] : ['unknown'];
                });
                console.warn('Incoming-call push delivery failure', { failed: results.length - delivered, codes: [...new Set(codes)] });
            }
            if (!delivered) {
                call.status = 'cancelled';
                save();
                res.status(502).json({ error: 'Push delivery failed. The recipient may need to enable ringing again.' });
                return;
            }
            // Accepted by FCM does not prove that a device rang or that the person answered.
            res.status(201).json({ callId: call.id, expiresAt: call.expiresAt, status: 'ringing', acceptedByPushService: delivered });
        }
        catch (error) {
            next(error);
        }
    }));
    router.get('/:token/calls/:id', (req, res) => {
        const call = res.locals.link.call;
        if (!call || call.id !== req.params.id) {
            res.sendStatus(404);
            return;
        }
        res.json(Object.assign(Object.assign({}, call), { status: call.status === 'ringing' && call.expiresAt <= clock() ? 'expired' : call.status }));
    });
    router.post('/:token/calls/:id/:action', (req, res, next) => __awaiter(this, void 0, void 0, function* () {
        const link = res.locals.link;
        const call = link.call;
        if (!call || call.id !== req.params.id) {
            res.sendStatus(404);
            return;
        }
        const action = req.params.action;
        if (!['answer', 'decline', 'cancel'].includes(action)) {
            res.sendStatus(400);
            return;
        }
        if (action !== 'cancel' && !authorized(req, link)) {
            res.sendStatus(401);
            return;
        }
        if (call.status !== 'ringing' || call.expiresAt <= clock()) {
            res.status(409).json({ error: 'This call has ended.' });
            return;
        }
        call.status = action === 'answer' ? 'answered' : action === 'decline' ? 'declined' : 'cancelled';
        save();
        try {
            yield Promise.allSettled(link.devices.map((device) => push(device.pushToken, { type: 'call-ended', callId: call.id, linkToken: req.params.token })));
            res.json({ status: call.status, room: link.room });
        }
        catch (error) {
            next(error);
        }
    }));
    return router;
}
