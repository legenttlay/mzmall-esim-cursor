import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeServer } from '../server/main.mjs';
import { startPortal } from '../server/portal.mjs';
import { fixture, purchaseArgs } from './fixture.mjs';

test('MCP discovery, host approval, balance payment and QR delivery work end to end with test-only data', async t => {
  const f = fixture(), portal = { accountUrl: () => 'http://127.0.0.1/test', approvalUrl: () => 'http://127.0.0.1/approve' };
  const server = makeServer({ service: f.service, store: f.store, portal });
  const client = new Client({ name: 'review-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let asked = 0;
  client.setRequestHandler(ElicitRequestSchema, async r => { asked++; assert.match(r.params.message, /1000 MMK/); assert.equal(f.state.payCalls, 0); return { action: 'accept', content: { approve: true } }; });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); f.close(); });
  const list = await client.listTools(); assert.equal(list.tools.length, 11);
  const payment = list.tools.find(t => t.name === 'pay_esim_purchase'); assert.equal(payment.annotations.readOnlyHint, false); assert.equal(payment.annotations.destructiveHint, true);
  assert.equal(JSON.stringify(list.tools).includes('card_number'), false);
  const p = (await client.callTool({ name: 'prepare_esim_purchase', arguments: purchaseArgs })).structuredContent;
  const paid = (await client.callTool({ name: 'pay_esim_purchase', arguments: { purchase_id: p.purchase_id, payment_method: 'balance' } })).structuredContent;
  assert.equal(asked, 1); assert.equal(paid.paid, true); assert.equal(paid.fulfilled, false);
  f.state.cards = [{ qrcode_content: 'LPA:1$test.smdp.example$non-working-test-code' }];
  const delivery = await client.callTool({ name: 'get_esim_delivery', arguments: { purchase_id: p.purchase_id } });
  assert.equal(delivery.structuredContent.fulfilled, true); assert.equal(delivery.content[1].type, 'image'); assert.equal(delivery.content[1].mimeType, 'image/png');
});

test('card checkout has no plugin approval hop, does not charge, and reuses its existing link', async t => {
  const f = fixture(), portal = { accountUrl: () => 'http://127.0.0.1/test', approvalUrl: () => { throw new Error('Card checkout must not request a separate approval page'); } };
  const server = makeServer({ service: f.service, store: f.store, portal });
  const client = new Client({ name: 'direct-card-checkout-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => { throw new Error('Card checkout must not request a redundant charge approval'); });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); f.close(); });
  const checkoutTool = (await client.listTools()).tools.find(t => t.name === 'open_esim_card_checkout');
  assert.equal(checkoutTool.annotations.destructiveHint, false);
  const p = (await client.callTool({ name: 'prepare_esim_purchase', arguments: purchaseArgs })).structuredContent;
  const checkout = (await client.callTool({ name: 'open_esim_card_checkout', arguments: { purchase_id: p.purchase_id } })).structuredContent;
  assert.equal(checkout.paid, false); assert.match(checkout.checkout_url, /^https:\/\/checkout.stripe.com\//);
  const reused = (await client.callTool({ name: 'pay_esim_purchase', arguments: { purchase_id: p.purchase_id, payment_method: 'card' } })).structuredContent;
  assert.equal(reused.checkout_url, checkout.checkout_url); assert.equal(f.state.count, 1); assert.equal(f.state.payCalls, 1);
  assert.equal(f.state.paid, false);
});
test('private sign-in portal rejects unknown session, Host and cross-origin POST before any email is sent', async t => {
  const f = fixture(), portal = await startPortal({ api: f.api, store: f.store, service: f.service });
  t.after(async () => { await new Promise(r => portal.server.close(r)); f.close(); });
  assert.equal((await fetch(portal.base)).status, 403);
  const redirect = await fetch(portal.accountUrl(), { redirect: 'manual' }), cookie = redirect.headers.get('set-cookie').split(';')[0];
  assert.equal(redirect.status, 303);
  const page = await fetch(portal.base, { headers: { cookie } }); assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const html = await page.text(); assert.equal(html.includes('test-user-token'), false);
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  for (const origin of ['https://evil.test', 'null', undefined]) {
    const bad = await fetch(`${portal.base}/send-code`, { method: 'POST', headers: { cookie, ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'buyer@example.test', csrf }) });
    assert.equal(bad.status, 403); assert.equal(f.state.calls.some(c => c.action === 'send_email_code'), false);
  }
  const badCsrf = await fetch(`${portal.base}/send-code`, { method: 'POST', headers: { cookie, Origin: portal.base }, body: new URLSearchParams({ email: 'buyer@example.test', csrf: 'incorrect' }) });
  assert.equal(badCsrf.status, 403); assert.equal(f.state.calls.some(c => c.action === 'send_email_code'), false);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(portal.base, { headers: { cookie, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  }); assert.equal(hostStatus, 403);
});

test('private sign-in portal accepts same-origin email and OTP forms with a valid session', async t => {
  const f = fixture(), portal = await startPortal({ api: f.api, store: f.store, service: f.service });
  f.store.delete('account', 'current');
  t.after(async () => { await new Promise(r => portal.server.close(r)); f.close(); });
  const redirect = await fetch(portal.accountUrl(), { redirect: 'manual' });
  assert.equal(redirect.headers.get('referrer-policy'), 'no-referrer');
  const cookie = redirect.headers.get('set-cookie').split(';')[0];
  const page = await fetch(portal.base, { headers: { cookie } });
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const headers = { cookie, Origin: portal.base, 'Content-Type': 'application/x-www-form-urlencoded' };
  const code = await fetch(`${portal.base}/send-code`, { method: 'POST', headers, body: new URLSearchParams({ email: 'buyer@example.test', csrf }) });
  assert.equal(code.status, 200); assert.match(await code.text(), /Check your email/);
  assert.equal(f.state.calls.filter(c => c.action === 'send_email_code').length, 1);
  const login = await fetch(`${portal.base}/login`, { method: 'POST', headers, body: new URLSearchParams({ email: 'buyer@example.test', code: '123456', csrf }) });
  assert.equal(login.status, 200);
  const connected = await login.text(); assert.match(connected, /Account connected/);
  assert.equal(connected.includes('test-login-token'), false);
  assert.equal(f.store.get('account', 'current').token, 'test-login-token');
  assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
});

test('code-send throttling keeps login available and page refresh never resends email', async t => {
  const f = fixture(), portal = await startPortal({ api: f.api, store: f.store, service: f.service });
  f.store.delete('account', 'current');
  f.state.before = async action => { if (action === 'send_email_code') throw new Error('Please wait 60 seconds before requesting a new code'); };
  t.after(async () => { await new Promise(r => portal.server.close(r)); f.close(); });
  const redirect = await fetch(portal.accountUrl(), { redirect: 'manual' });
  const cookie = redirect.headers.get('set-cookie').split(';')[0];
  const page = await fetch(portal.base, { headers: { cookie } });
  const csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const headers = { cookie, Origin: portal.base, 'Content-Type': 'application/x-www-form-urlencoded' };
  const send = () => fetch(`${portal.base}/send-code`, { method: 'POST', headers, body: new URLSearchParams({ email: 'buyer@example.test', csrf }), redirect: 'manual' });
  const posted = await send(); assert.equal(posted.status, 303); assert.equal(posted.headers.get('location'), '/');
  const result = await fetch(portal.base, { headers: { cookie } });
  const html = await result.text();
  assert.match(html, /Please wait 60 seconds/);
  assert.match(html, /does not confirm email delivery/);
  assert.match(html, /action="\/login"/); assert.match(html, /value="buyer@example.test"/);
  assert.equal(f.store.get('account', 'current'), null);
  await fetch(portal.base, { headers: { cookie } });
  assert.equal((await send()).status, 303);
  assert.equal(f.state.calls.filter(c => c.action === 'send_email_code').length, 1);
  const connected = await fetch(`${portal.base}/login`, { method: 'POST', headers, body: new URLSearchParams({ email: 'buyer@example.test', code: '123456', csrf }) });
  assert.equal(connected.status, 200); assert.match(await connected.text(), /Account connected/);
  assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
});

test('concurrent code-send submissions call the email API once and failed OTP entry keeps its form', async t => {
  const f = fixture(), portal = await startPortal({ api: f.api, store: f.store, service: f.service });
  f.store.delete('account', 'current');
  t.after(async () => { await new Promise(r => portal.server.close(r)); f.close(); });
  const redirect = await fetch(portal.accountUrl(), { redirect: 'manual' });
  const cookie = redirect.headers.get('set-cookie').split(';')[0];
  const page = await fetch(portal.base, { headers: { cookie } });
  const csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const headers = { cookie, Origin: portal.base, 'Content-Type': 'application/x-www-form-urlencoded' };
  let started, release;
  const pending = new Promise(r => { release = r; });
  const emailStarted = new Promise(r => { started = r; });
  f.state.before = async action => {
    if (action === 'send_email_code') { started(); await pending; }
    if (action === 'login_email') throw new Error('Invalid or expired verification code');
  };
  const send = () => fetch(`${portal.base}/send-code`, { method: 'POST', headers, body: new URLSearchParams({ email: 'buyer@example.test', csrf }), redirect: 'manual' });
  const first = send(); await emailStarted;
  const duplicate = await send(); assert.equal(duplicate.status, 303);
  release(); assert.equal((await first).status, 303);
  assert.equal(f.state.calls.filter(c => c.action === 'send_email_code').length, 1);
  const denied = await fetch(`${portal.base}/login`, { method: 'POST', headers, body: new URLSearchParams({ email: 'buyer@example.test', code: '987654', csrf }) });
  assert.equal(denied.status, 200);
  const html = await denied.text(); assert.match(html, /Invalid or expired verification code/);
  assert.match(html, /action="\/login"/); assert.equal(html.includes('987654'), false);
  assert.equal(f.store.get('account', 'current'), null);
  assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
});

test('two loopback portals retain separate browser sessions and reject each other\'s form token', async t => {
  const a = fixture(), b = fixture();
  const first = await startPortal({ api: a.api, store: a.store, service: a.service });
  const second = await startPortal({ api: b.api, store: b.store, service: b.service });
  t.after(async () => {
    await Promise.all([first, second].map(p => new Promise(r => p.server.close(r))));
    a.close(); b.close();
  });
  // Cookies are scoped to host/path, not port. Model the browser replacing a
  // same-name cookie when another local portal opens on 127.0.0.1.
  const jar = new Map();
  const visit = async portal => {
    const response = await fetch(portal.accountUrl(), { redirect: 'manual' });
    const [name, value] = response.headers.get('set-cookie').split(';')[0].split('=');
    jar.set(name, value);
  };
  const headers = () => ({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
  await visit(first);
  assert.equal((await fetch(first.base, { headers: headers() })).status, 200);
  await visit(second);
  assert.equal(jar.size, 2);
  const firstPage = await fetch(first.base, { headers: headers() });
  const secondPage = await fetch(second.base, { headers: headers() });
  assert.equal(firstPage.status, 200); assert.equal(secondPage.status, 200);
  const otherCsrf = (await secondPage.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const wrongForm = await fetch(`${first.base}/send-code`, {
    method: 'POST', headers: { ...headers(), Origin: first.base },
    body: new URLSearchParams({ csrf: otherCsrf, email: 'buyer@example.test' }),
  });
  assert.equal(wrongForm.status, 403);
  assert.equal(a.state.calls.some(c => c.action === 'send_email_code'), false);
});
