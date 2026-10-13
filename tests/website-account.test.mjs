import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WebsiteAccountConnection } from '../server/website-account.mjs';
import { fixture } from './fixture.mjs';
import { startPortal } from '../server/portal.mjs';

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
  const callbackHtml = await callback.text(); assert.match(callbackHtml, /Account connected/);
  assert.equal(callbackHtml.includes('new-website-test-token'), false);
  const statusUrl = callbackHtml.match(/href="(\/\?session=[a-f0-9]+)"/)[1];
  const session = await fetch(new URL(statusUrl, portal.base), { redirect: 'manual' });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const page = await fetch(portal.base, { headers: { cookie } });
  const html = await page.text(); assert.match(html, /Account connected/);
  assert.equal(html.includes('name="email"'), false); assert.equal(html.includes('name="code"'), false);
  assert.equal(html.includes('new-website-test-token'), false);
  const retired = await fetch(`${portal.base}/send-code`, { method: 'POST', headers: { cookie, Origin: portal.base }, body: 'email=buyer%40example.test' });
  assert.equal(retired.status, 410); assert.equal(f.state.calls.some(c => c.action === 'send_email_code'), false);
  assert.equal(f.state.count, 0); assert.equal(f.state.payCalls, 0);
});
