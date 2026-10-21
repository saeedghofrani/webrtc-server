const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { callLinksRouter } = require('./callLinks');

test('private links persist, require device credentials, deliver short-lived calls and cancel all devices', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'meet-call-test-'));
  const file = join(directory, 'calls.json');
  const pushes = [];
  let now = Date.now();
  let failPush = false;
  const push = async (token, data) => { if (failPush) throw new Error('Provider unavailable'); pushes.push({ token, data }); };
  const app = express().use(express.json()).use('/api/call-links', callLinksRouter({ file, push, enabled: true, clock: () => now }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/call-links`;
  async function request(path, method = 'GET', body, credential) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  try {
    assert.equal((await request('/invalid')).status, 404);
    const created = await request('/', 'POST', {});
    assert.equal(created.status, 201);
    const token = created.body.token;
    assert.match(token, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal((await request(`/${token}/calls`, 'POST', { caller: 'A' })).status, 409);
    const subscribed = await request(`/${token}/subscriptions`, 'POST', { pushToken: 'test-device-push-token-1' });
    assert.equal(subscribed.status, 201);
    const credential = subscribed.body.credential;
    assert.equal((await request(`/${token}/subscriptions`, 'POST', { pushToken: 'test-device-push-token-1' })).status, 409);
    assert.equal((await request(`/${token}/subscriptions`, 'POST', { pushToken: 'test-device-push-token-2' }, credential)).status, 200);
    assert.equal((await request(`/${token}`)).body.recipients, 1);
    const ringing = await request(`/${token}/calls`, 'POST', { caller: 'Saeed' });
    assert.equal(ringing.status, 201);
    assert.equal(pushes[0].token, 'test-device-push-token-2');
    assert.equal(pushes[0].data.type, 'incoming-call');
    assert.ok(Number(pushes[0].data.expiresAt) - Date.now() <= 45000);
    assert.equal((await request(`/${token}/calls`, 'POST', { caller: 'Again' })).status, 429);
    const callPath = `/${token}/calls/${ringing.body.callId}`;
    assert.equal((await request(`${callPath}/answer`, 'POST', {})).status, 401);
    assert.equal((await request(`${callPath}/answer`, 'POST', {}, credential)).body.status, 'answered');
    assert.equal(pushes.at(-1).data.type, 'call-ended');
    assert.equal((await request(`${callPath}/decline`, 'POST', {}, credential)).status, 409);
    assert.equal((await request(callPath)).body.status, 'answered');
    now += 61000;
    const second = await request(`/${token}/calls`, 'POST', { caller: 'Second' });
    assert.equal(second.status, 201);
    const secondPath = `/${token}/calls/${second.body.callId}`;
    assert.equal((await request(`${secondPath}/cancel`, 'POST', {})).body.status, 'cancelled');
    assert.equal(pushes.at(-1).data.type, 'call-ended');
    now += 61000;
    const expiring = await request(`/${token}/calls`, 'POST', { caller: 'Late' });
    const expiredPath = `/${token}/calls/${expiring.body.callId}`;
    now += 45001;
    assert.equal((await request(expiredPath)).body.status, 'expired');
    assert.equal((await request(`${expiredPath}/answer`, 'POST', {}, credential)).status, 409);
    now += 61000;
    failPush = true;
    assert.equal((await request(`/${token}/calls`, 'POST', { caller: 'No delivery' })).status, 502);
    assert.equal((await request(`/${token}/subscriptions`, 'DELETE', undefined, 'wrong')).status, 401);
    // A new process/router must be able to load the durable registry.
    assert.doesNotThrow(() => callLinksRouter({ file, push, enabled: true }));
    assert.equal((await request(`/${token}/subscriptions`, 'DELETE', undefined, credential)).status, 204);
    assert.equal((await request(`/${token}`)).body.recipients, 0);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true }); }
});

test('disabled push configuration refuses link creation', async () => {
  const app = express().use(callLinksRouter({ file: join(tmpdir(), `absent-${Date.now()}.json`), enabled: false }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST' });
    assert.equal(response.status, 503);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
