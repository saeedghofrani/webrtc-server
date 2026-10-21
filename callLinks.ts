import { Router, Request } from 'express';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

type Device = { id: string; secretHash: string; pushToken: string };
type Call = { id: string; caller: string; expiresAt: number; status: 'ringing' | 'answered' | 'declined' | 'cancelled' };
type Link = { room: string; devices: Device[]; call?: Call; lastRing?: number };
type State = Record<string, Link>;
export type Push = (token: string, data: Record<string, string>) => Promise<void>;
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export const firebasePush: Push = async (token, data) => {
  const app = getApps()[0] || initializeApp({ credential: applicationDefault() });
  await getMessaging(app).send({ token, data, android: { priority: 'high', ttl: 45000, restrictedPackageName: 'xyz.saeedghofrani.meet' } });
};

// One process owns this bounded, atomically replaced file. Mount its directory on a durable volume.
export function callLinksRouter(options: { file?: string; push?: Push; enabled?: boolean; clock?: () => number } = {}) {
  const router = Router();
  const file = resolve(options.file || process.env.CALL_LINK_STORE || '.data/call-links.json');
  const enabled = options.enabled ?? process.env.CALL_PUSH_ENABLED === 'true';
  const push = options.push || firebasePush;
  const clock = options.clock || Date.now;
  let state: State = {};
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const budgets = new Map<string, { count: number; until: number }>();
  router.use((req, res, next) => {
    const origin = req.get('Origin');
    const allowed = (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',');
    if (origin && origin !== `${req.protocol}://${req.get('Host')}` && !allowed.includes(origin)) { res.sendStatus(403); return; }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin); res.vary('Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use((req, res, next) => {
    const now = clock();
    for (const [key, value] of budgets) if (value.until <= now) budgets.delete(key);
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const budget = budgets.get(key) || { count: 0, until: now + 60000 };
    if (budgets.size >= 10000 && !budgets.has(key)) { res.sendStatus(429); return; }
    budgets.set(key, budget);
    if (++budget.count > 120) { res.sendStatus(429); return; }
    next();
  });
  router.get('/config', (_req, res) => res.json({ enabled, ringSeconds: 45 }));
  router.post('/', (_req, res) => {
    if (!enabled) { res.status(503).json({ error: 'Incoming calls are not configured yet.' }); return; }
    if (Object.keys(state).length >= 2000) { res.status(503).json({ error: 'Call link capacity reached.' }); return; }
    const token = secret();
    state[hash(token)] = { room: randomBytes(12).toString('hex').toUpperCase(), devices: [] };
    save();
    res.status(201).json({ token, room: state[hash(token)].room });
  });
  router.use('/:token', (req, res, next) => {
    if (!validToken(req.params.token) || !state[hash(req.params.token)]) { res.sendStatus(404); return; }
    res.locals.link = state[hash(req.params.token)]; next();
  });
  // Management credentials contain a random verifier stored only on the recipient device.
  const authorized = (req: Request, link: Link) => {
    const [id, verifier] = (req.get('Authorization') || '').replace(/^Bearer /, '').split('.');
    return verifier && link.devices.find((device) => device.id === id && device.secretHash === hash(verifier));
  };
  router.get('/:token', (_req, res) => {
    const link: Link = res.locals.link;
    res.json({ room: link.room, recipients: link.devices.length, enabled });
  });
  router.post('/:token/subscriptions', (req, res) => {
    const link: Link = res.locals.link;
    if (!enabled) { res.sendStatus(503); return; }
    const pushToken = req.body?.pushToken;
    if (typeof pushToken !== 'string' || pushToken.length < 20 || pushToken.length > 4096 || /\s/.test(pushToken)) { res.sendStatus(400); return; }
    const current = authorized(req, link);
    if (current) { current.pushToken = pushToken; save(); res.json({ updated: true }); return; }
    if (link.devices.some((device) => device.pushToken === pushToken)) { res.status(409).json({ error: 'Device already registered. Disable and enable ringing to recover.' }); return; }
    if (link.devices.length >= 10) { res.sendStatus(409); return; }
    const verifier = secret();
    const device: Device = { id: secret(), secretHash: hash(verifier), pushToken };
    link.devices.push(device); save();
    res.status(201).json({ credential: `${device.id}.${verifier}` });
  });
  router.delete('/:token/subscriptions', (req, res) => {
    const link: Link = res.locals.link;
    const device = authorized(req, link);
    if (!device) { res.sendStatus(401); return; }
    link.devices = link.devices.filter((item) => item !== device); save(); res.sendStatus(204);
  });
  router.post('/:token/calls', async (req, res, next) => {
    const link: Link = res.locals.link;
    if (!enabled) { res.sendStatus(503); return; }
    if (!link.devices.length) { res.status(409).json({ error: 'The recipient must enable ringing in the Android app first.' }); return; }
    if (clock() - (link.lastRing || 0) < 60000) { res.status(429).json({ error: 'Please wait a minute before ringing again.' }); return; }
    const caller = typeof req.body?.caller === 'string' ? req.body.caller.trim().slice(0, 40) : '';
    if (!caller) { res.sendStatus(400); return; }
    const call: Call = { id: secret(), caller, expiresAt: clock() + 45000, status: 'ringing' };
    link.call = call; link.lastRing = clock(); save();
    try {
      const results = await Promise.allSettled(link.devices.map(async (device) => {
        try { await push(device.pushToken, { type: 'incoming-call', linkToken: req.params.token, callId: call.id, caller, room: link.room, expiresAt: String(call.expiresAt) }); }
        catch (error) {
          if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes((error as { code: string }).code)) {
            link.devices = link.devices.filter((item) => item !== device); save();
          }
          throw error;
        }
      }));
      const delivered = results.filter((result) => result.status === 'fulfilled').length;
      if (push === firebasePush && delivered < results.length) {
        const codes = results.flatMap((result) => {
          if (result.status !== 'rejected') return [];
          const code = String(result.reason?.code || 'unknown');
          return /^[a-z0-9/-]{1,80}$/i.test(code) ? [code] : ['unknown'];
        });
        console.warn('Incoming-call push delivery failure', { failed: results.length - delivered, codes: [...new Set(codes)] });
      }
      if (!delivered) { call.status = 'cancelled'; save(); res.status(502).json({ error: 'Push delivery failed. The recipient may need to enable ringing again.' }); return; }
      // Accepted by FCM does not prove that a device rang or that the person answered.
      res.status(201).json({ callId: call.id, expiresAt: call.expiresAt, status: 'ringing', acceptedByPushService: delivered });
    } catch (error) { next(error); }
  });
  router.get('/:token/calls/:id', (req, res) => {
    const call: Call | undefined = res.locals.link.call;
    if (!call || call.id !== req.params.id) { res.sendStatus(404); return; }
    res.json({ ...call, status: call.status === 'ringing' && call.expiresAt <= clock() ? 'expired' : call.status });
  });
  router.post('/:token/calls/:id/:action', async (req, res, next) => {
    const link: Link = res.locals.link;
    const call = link.call;
    if (!call || call.id !== req.params.id) { res.sendStatus(404); return; }
    const action = req.params.action;
    if (!['answer', 'decline', 'cancel'].includes(action)) { res.sendStatus(400); return; }
    if (action !== 'cancel' && !authorized(req, link)) { res.sendStatus(401); return; }
    if (call.status !== 'ringing' || call.expiresAt <= clock()) { res.status(409).json({ error: 'This call has ended.' }); return; }
    call.status = action === 'answer' ? 'answered' : action === 'decline' ? 'declined' : 'cancelled'; save();
    try {
      await Promise.allSettled(link.devices.map((device) => push(device.pushToken, { type: 'call-ended', callId: call.id, linkToken: req.params.token })));
      res.json({ status: call.status, room: link.room });
    } catch (error) { next(error); }
  });
  return router;
}
