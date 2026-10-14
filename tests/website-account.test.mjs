import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WebsiteAccountConnection } from '../server/website-account.mjs';
import { fixture } from './fixture.mjs';
import { startPortal } from '../server/portal.mjs';
import { makeServer } from '../server/main.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setTimeout as delay } from 'node:timers/promises';

function connectionFixture() {
  const f = fixture(), call = f.api.call.bind(f.api), flowId = 'c'.repeat(64), code = 'd'.repeat(64);
  f.api.origin = 'https://888688889.com';
  let startArgs, exchanges = 0;
  f.api.call = async (action, params, options) => {
    if (action === 'agent_connect_start') {
      startArgs = params;
      return { connection_id: flowId, authorization_url: `https://888688889.com/index.php/Home/API/EsimApi/agent_connect_page.html?connection=${flowId}` };
    }
    if (action === 'agent_connect_exchange') {
      exchanges++;
      assert.equal(createHash('sha256').update(params.code_verifier).digest('base64url'), startArgs.code_challenge);
      if (f.state.exchangeError) throw new Error('Submitted connection result unknown');
      return { token: 'new-website-test-token', uid: f.state.loginUid ?? 1, expire_time: 2000000000 };
    }
    return call(action, params, options);
  };
  const bridge = new WebsiteAccountConnection({ api: f.api, store: f.store });
  return { ...f, bridge, code, start: () => startArgs, exchanges: () => exchanges, params: () => new URLSearchParams({ state: startArgs.state, code }) };
}
test('website connection reuses the merchant website and consumes a protected callback once', async t => {
  const f = connectionFixture(); t.after(f.close);
  const url = await f.bridge.begin('http://127.0.0.1:54321');
  assert.match(url, /^https:\/\/888688889\.com\/index.php\/Home\/API\/EsimApi\/agent_connect_page.html\?connection=/);
  assert.equal(url.includes(f.start().state), false); assert.equal(url.includes('new-website-test-token'), false);
  assert.deepEqual(await f.bridge.complete(f.params(), f.start().redirect_uri), { connected: true });
  assert.equal(f.store.get('account', 'current').token, 'new-website-test-token');
  await assert.rejects(f.bridge.complete(f.params(), f.start().redirect_uri), /expired or interrupted/);
  assert.equal(f.exchanges(), 1); assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
});
test('website callback rejects wrong state, callback, duplicate parameters and another identity', async t => {
  const f = connectionFixture(); t.after(f.close); await f.bridge.begin('http://127.0.0.1:54321');
  await assert.rejects(f.bridge.complete(new URLSearchParams({ state: 'e'.repeat(64), code: f.code }), f.start().redirect_uri), /expired or interrupted/);
  await assert.rejects(f.bridge.complete(f.params(), 'http://127.0.0.1:54322/account-callback'), /expired or interrupted/);
  const duplicate = f.params(); duplicate.append('code', f.code);
  await assert.rejects(f.bridge.complete(duplicate, f.start().redirect_uri), /Invalid account/);
  assert.equal(f.exchanges(), 0);
  f.state.loginUid = 2;
  await assert.rejects(f.bridge.complete(f.params(), f.start().redirect_uri), /identity did not match/);
  assert.equal(f.store.get('account', 'current').token, 'test-user-token');
});
test('cancelled website connection and unknown exchange results cannot be replayed', async t => {
  const f = connectionFixture(); t.after(f.close); await f.bridge.begin('http://127.0.0.1:54321');
  const cancelled = new URLSearchParams({ state: f.start().state, error: 'access_denied' });
  assert.deepEqual(await f.bridge.complete(cancelled, f.start().redirect_uri), { connected: false, cancelled: true });
  assert.equal(f.exchanges(), 0); assert.equal(f.store.get('account', 'current').token, 'test-user-token');
  await f.bridge.begin('http://127.0.0.1:54321'); f.state.exchangeError = true;
  await assert.rejects(f.bridge.complete(f.params(), f.start().redirect_uri), /unknown/);
  await assert.rejects(f.bridge.complete(f.params(), f.start().redirect_uri), /expired or interrupted/);
  assert.equal(f.exchanges(), 1); assert.equal(f.state.payCalls, 0);
});
test('untrusted merchant authorization URLs cannot be passed to the customer', async t => {
  const f = fixture(); t.after(f.close);
  f.api.call = async () => ({ connection_id: 'c'.repeat(64), authorization_url: `https://evil.test/index.php/Home/API/EsimApi/agent_connect_page.html?connection=${'c'.repeat(64)}` });
  const bridge = new WebsiteAccountConnection({ api: f.api, store: f.store });
  await assert.rejects(bridge.begin('http://127.0.0.1:54321'), /Invalid website/);
});

test('website sign-in callback needs no local cookie and the local page has no OTP form', async t => {
  const f = connectionFixture(), portal = await startPortal({ api: f.api, store: f.store, service: f.service, websiteLogin: true });
  t.after(async () => { await new Promise(r => portal.server.close(r)); f.close(); });
  assert.match(await portal.accountUrl(), /^https:\/\/888688889\.com\/index.php\/Home\/API\/EsimApi\/agent_connect_page/);
  const callback = await fetch(`${portal.base}/account-callback?${f.params()}`, { redirect: 'manual' });
  assert.equal(callback.status, 200);
  const callbackHtml = await callback.text(); assert.match(callbackHtml, /账号连接成功/);
  assert.match(callbackHtml, /返回 Cursor 继续/);
  const returnLink = callbackHtml.match(/href="(cursor:\/\/[^\"]+)"/)[1];
  const returnPrompt = new URL(returnLink.replaceAll('&amp;', '&')).searchParams.get('text');
  assert.match(returnPrompt, /get_esim_account/); assert.match(returnPrompt, /connection_id=/);
  assert.equal(returnPrompt.includes('buyer@example.test'), false);
  assert.equal(callbackHtml.includes('new-website-test-token'), false);
  const session = await fetch(portal.statusUrl(), { redirect: 'manual' });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const page = await fetch(portal.base, { headers: { cookie } });
  const html = await page.text(); assert.match(html, /账号连接成功/);
  assert.equal(html.includes('buyer@example.test'), false); assert.equal(html.includes('9000 MMK'), false);
  assert.equal(html.includes('action="/disconnect"'), false);
  assert.equal(html.includes('name="email"'), false); assert.equal(html.includes('name="code"'), false);
  assert.equal(html.includes('new-website-test-token'), false);
  assert.equal((await fetch(`${portal.base}/account`)).status, 403);
  const accountPage = await fetch(`${portal.base}/account`, { headers: { cookie } });
  const accountHtml = await accountPage.text(); assert.match(accountHtml, /账号管理/);
  assert.match(accountHtml, /buyer@example.test/); assert.match(accountHtml, /9000 MMK/);
  assert.match(accountHtml, /action="\/disconnect"/);
  const retired = await fetch(`${portal.base}/send-code`, { method: 'POST', headers: { cookie, Origin: portal.base }, body: 'email=buyer%40example.test' });
  assert.equal(retired.status, 410); assert.equal(f.state.calls.some(c => c.action === 'send_email_code'), false);
  assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
});

test('login completion wakes the waiting account tool and restores the selected eSIM without buying', async t => {
  const f = connectionFixture(); f.store.delete('account', 'current');
  const portal = await startPortal({ api: f.api, store: f.store, service: f.service, websiteLogin: true });
  const server = makeServer({ service: f.service, portal, store: f.store });
  const client = new Client({ name: 'resume-login-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); await new Promise(r => portal.server.close(r)); f.close(); });
  const shopping = { intent: 'purchase', country_code: 'TH', validity_days: 7, product_id: 101, quantity: 1, max_total_mmk: 1000 };
  const link = (await client.callTool({ name: 'connect_esim_account', arguments: { shopping_request: shopping } })).structuredContent;
  assert.equal(link.connection_id, 'c'.repeat(64)); assert.equal(link.expires_in_seconds, 600);
  const pending = (await client.callTool({ name: 'get_esim_account', arguments: { connection_id: link.connection_id } })).structuredContent;
  assert.equal(pending.connected, false); assert.equal(pending.state, 'awaiting_login');
  assert.equal(pending.shopping_request, undefined); assert.equal(pending.email, undefined);
  const waiting = client.callTool({ name: 'get_esim_account', arguments: { connection_id: link.connection_id, wait_seconds: 2 } });
  await delay(50);
  const params = new URLSearchParams({ state: f.start().state, code: f.code });
  const callback = await fetch(`${portal.base}/account-callback?${params}`);
  assert.equal(callback.status, 200);
  const connected = (await waiting).structuredContent;
  assert.equal(connected.connected, true); assert.deepEqual(connected.shopping_request, shopping);
  assert.equal(connected.account_id, 1); assert.equal(connected.balance, 9000);
  assert.equal(JSON.stringify(connected).includes('new-website-test-token'), false);
  assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
  f.state.uid = 2;
  const anotherAccount = await client.callTool({ name: 'get_esim_account', arguments: { connection_id: link.connection_id } });
  assert.equal(anotherAccount.isError, true); assert.match(anotherAccount.content[0].text, /different account/);
  assert.equal(JSON.stringify(anotherAccount).includes('max_total_mmk'), false);
});

test('cancelled, expired and interrupted connections do not return a resumable selection', async t => {
  const f = connectionFixture(); t.after(f.close);
  await f.bridge.begin('http://127.0.0.1:54321', { intent: 'purchase', product_id: 101 });
  assert.equal(f.bridge.status('c'.repeat(64)).state, 'awaiting_login');
  await f.bridge.complete(new URLSearchParams({ state: f.start().state, error: 'access_denied' }), f.start().redirect_uri);
  assert.deepEqual(Object.keys(f.bridge.status('c'.repeat(64))).sort(), ['expires', 'state']);
  assert.equal(f.bridge.status('c'.repeat(64)).state, 'cancelled');
  await f.bridge.begin('http://127.0.0.1:54321'); f.state.exchangeError = true;
  await assert.rejects(f.bridge.complete(f.params(), f.start().redirect_uri), /unknown/);
  assert.equal(f.bridge.status('c'.repeat(64)).state, 'interrupted');
  f.bridge.now = () => Date.now() + 700000;
  assert.deepEqual(f.bridge.status('c'.repeat(64)), { state: 'expired' });
  assert.deepEqual(f.bridge.status('e'.repeat(64)), { state: 'unknown' });
  assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
});

test('an expired website account never shows the connected return button', async t => {
  const f = connectionFixture();
  f.state.before = async action => { if (action === 'user_info') throw new Error('Unauthorized'); };
  const portal = await startPortal({ api: f.api, store: f.store, service: f.service, websiteLogin: true });
  t.after(async () => { await new Promise(r => portal.server.close(r)); f.close(); });
  const session = await fetch(portal.statusUrl(), { redirect: 'manual' });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const response = await fetch(portal.base, { headers: { cookie } });
  const html = await response.text();
  assert.match(html, /session expired/); assert.match(html, /使用网站账号连接/);
  assert.equal(html.includes('return-button'), false); assert.equal(html.includes('Account connected'), false);
});
