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
  const list = await client.listTools(); assert.equal(list.tools.length, 10);
  const payment = list.tools.find(t => t.name === 'pay_esim_purchase'); assert.equal(payment.annotations.readOnlyHint, false); assert.equal(payment.annotations.destructiveHint, true);
  assert.equal(JSON.stringify(list.tools).includes('card_number'), false);
  const p = (await client.callTool({ name: 'prepare_esim_purchase', arguments: purchaseArgs })).structuredContent;
  const paid = (await client.callTool({ name: 'pay_esim_purchase', arguments: { purchase_id: p.purchase_id, payment_method: 'balance' } })).structuredContent;
  assert.equal(asked, 1); assert.equal(paid.paid, true); assert.equal(paid.fulfilled, false);
  f.state.cards = [{ qrcode_content: 'LPA:1$test.smdp.example$non-working-test-code' }];
  const delivery = await client.callTool({ name: 'get_esim_delivery', arguments: { purchase_id: p.purchase_id } });
  assert.equal(delivery.structuredContent.fulfilled, true); assert.equal(delivery.content[1].type, 'image'); assert.equal(delivery.content[1].mimeType, 'image/png');
});
test('private sign-in portal rejects unknown session, Host and cross-origin POST before any email is sent', async t => {
  const f = fixture(), portal = await startPortal({ api: f.api, store: f.store, service: f.service });
  t.after(async () => { await new Promise(r => portal.server.close(r)); f.close(); });
  assert.equal((await fetch(portal.base)).status, 403);
  const redirect = await fetch(portal.accountUrl(), { redirect: 'manual' }), cookie = redirect.headers.get('set-cookie').split(';')[0];
  assert.equal(redirect.status, 303);
  const page = await fetch(portal.base, { headers: { cookie } }); assert.equal(page.status, 200);
  assert.equal((await page.text()).includes('test-user-token'), false);
  const bad = await fetch(`${portal.base}/send-code`, { method: 'POST', headers: { cookie, Origin: 'https://evil.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=buyer%40example.test' });
  assert.equal(bad.status, 403); assert.equal(f.state.calls.some(c => c.action === 'send_email_code'), false);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(portal.base, { headers: { cookie, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  }); assert.equal(hostStatus, 403);
});
