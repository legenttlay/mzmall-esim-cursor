import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { EsimApi } from '../server/api.mjs';
import { fixture, purchaseArgs } from './fixture.mjs';

test('catalog excludes upstream cost and credentials', async t => {
  const f = fixture(); t.after(f.close);
  const p = await f.service.product(101);
  assert.equal(p.currency, 'MMK'); assert.equal(p.unit_price, 1000);
  assert.equal('cost_price' in p, false); assert.equal(JSON.stringify(p).includes('must-not-return'), false);
});
test('same request reuses unpaid order; changing details or budget fails', async t => {
  const f = fixture(); t.after(f.close);
  const a = await f.service.prepare(purchaseArgs), b = await f.service.prepare(purchaseArgs);
  assert.equal(a.purchase_id, b.purchase_id); assert.equal(f.state.count, 1);
  await assert.rejects(f.service.prepare({ ...purchaseArgs, quantity: 2 }), /request ID/);
  await assert.rejects(f.service.prepare({ ...purchaseArgs, max_total_mmk: 900, request_id: 'second-request' }), /budget/);
  assert.equal(f.state.count, 1);
});
test('declining approval cannot charge', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs);
  const r = await f.service.pay(p.purchase_id, 'balance', async () => false);
  assert.equal(r.state, 'approval_required'); assert.equal(f.state.payCalls, 0);
});
test('price change while waiting for approval prevents payment', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs);
  await assert.rejects(f.service.pay(p.purchase_id, 'balance', async () => { f.state.orderPrice = 1200; return true; }), /price changed/);
  assert.equal(f.state.payCalls, 0);
});
test('successful balance payment is verified and repeated invocation cannot charge twice', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs);
  const r = await f.service.pay(p.purchase_id, 'balance', async () => true);
  assert.equal(r.paid, true); assert.equal(r.fulfilled, false); assert.equal(r.state, 'paid_awaiting_fulfillment');
  await f.service.pay(p.purchase_id, 'balance', async () => true);
  assert.equal(f.state.payCalls, 1);
  const reused = await f.service.prepare(purchaseArgs); assert.equal(reused.paid, true);
});
test('concurrent payment requests are serialized', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs);
  let release, signal; const entered = new Promise(r => { signal = r; });
  const first = f.service.pay(p.purchase_id, 'balance', async () => { signal(); await new Promise(r => { release = r; }); return true; });
  await entered;
  await assert.rejects(f.service.pay(p.purchase_id, 'balance', async () => true), /already running/);
  release(); await first; assert.equal(f.state.payCalls, 1);
});
test('unknown payment result is journaled and never retried, including after restart', async t => {
  const f = fixture(); const p = await f.service.prepare(purchaseArgs); f.state.payError = true;
  await assert.rejects(f.service.pay(p.purchase_id, 'balance', async () => true), /not confirmed/);
  f.store.close(); f.service.store = new Store(f.directory); t.after(() => f.service.store.close());
  const r = await f.service.pay(p.purchase_id, 'balance', async () => true);
  assert.equal(r.state, 'payment_unknown'); assert.equal(f.state.payCalls, 1);
});
test('paid transaction after a lost response is recovered without charging again', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs);
  f.state.payError = true; f.state.paidBeforeError = true;
  await assert.rejects(f.service.pay(p.purchase_id, 'balance', async () => true));
  const r = await f.service.pay(p.purchase_id, 'balance', async () => true);
  assert.equal(r.paid, true); assert.equal(f.state.payCalls, 1);
});
test('an upstream-reused order with a second request ID cannot bypass an unknown payment attempt', async t => {
  const f = fixture(); t.after(f.close);
  const p1 = await f.service.prepare(purchaseArgs), p2 = await f.service.prepare({ ...purchaseArgs, request_id: 'another-request-0001' });
  assert.equal(p1.order_id, p2.order_id); f.state.payError = true;
  await assert.rejects(f.service.pay(p1.purchase_id, 'balance', async () => true));
  const r = await f.service.pay(p2.purchase_id, 'balance', async () => true);
  assert.equal(r.state, 'payment_unknown'); assert.equal(f.state.payCalls, 1);
});
test('purchase disable switch also blocks existing unpaid orders', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs); f.service.purchasesEnabled = false;
  await assert.rejects(f.service.pay(p.purchase_id, 'balance', async () => true), /not enabled/);
  assert.equal(f.state.payCalls, 0);
});
test('account switch and unpaid cards cannot disclose installation credentials', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs);
  f.state.cards = [{ qrcode_content: 'LPA:1$test.smdp.example$test-secret-code', sn_pin: 'never-return' }];
  const unpaid = await f.service.status(p.purchase_id, true); assert.equal(unpaid.esims, undefined);
  f.state.uid = 2;
  await assert.rejects(f.service.status(p.purchase_id, true), /connected account/);
});
test('partial delivery is distinct from complete delivery and raw card secrets are excluded', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare({ ...purchaseArgs, quantity: 2, max_total_mmk: 2000 });
  f.state.paid = true; f.state.status = 0;
  f.state.cards = [{ qrcode_content: 'LPA:1$test.smdp.example$test-secret-code', sn_pin: 'never-return', iccid: 'test-only' }];
  const partial = await f.service.status(p.purchase_id, true);
  assert.equal(partial.fulfilled, false); assert.equal(partial.esims.length, 1); assert.equal(JSON.stringify(partial).includes('never-return'), false);
  f.state.cards.push({ qrcode_content: 'LPA:1$test.smdp.example$test-code-2' });
  assert.equal((await f.service.status(p.purchase_id, true)).fulfilled, true);
  f.state.status = -1; const closed = await f.service.status(p.purchase_id, true);
  assert.equal(closed.fulfilled, false); assert.equal(closed.esims, undefined);
});
test('card checkout URL is not a payment receipt and is reused', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs);
  const q = await f.service.quote(p.purchase_id, 'card'); assert.equal(q.total, 2.26); assert.equal(q.currency, 'CNY');
  const r = await f.service.pay(p.purchase_id, 'card', async () => true);
  assert.equal(r.paid, false); assert.match(r.checkout_url, /^https:\/\/checkout.stripe.com\//);
  await f.service.pay(p.purchase_id, 'card', async () => true); assert.equal(f.state.payCalls, 1);
});
test('unexpected checkout domain cannot be returned to the buyer', async t => {
  const f = fixture(); t.after(f.close); const p = await f.service.prepare(purchaseArgs); f.state.checkoutUrl = 'https://checkout.stripe.com.evil.test/pay';
  await assert.rejects(f.service.pay(p.purchase_id, 'card', async () => true), /not confirmed/);
  assert.equal(f.store.get('purchase', '1:test-request-0001').checkout_url, undefined);
});
test('vault does not store credentials in plaintext', t => {
  const f = fixture(); t.after(f.close);
  const stored = f.store.db.prepare('SELECT payload FROM records WHERE kind=?').get('account').payload;
  assert.equal(stored.includes('test-user-token'), false); assert.equal(f.store.get('account', 'current').token, 'test-user-token');
});
test('API prevents redirect credential forwarding and sanitizes gateway exceptions', async () => {
  let options;
  const api = new EsimApi({ fetchImpl: async (url, opts) => { options = opts; return new Response(JSON.stringify({ code: 0, msg: 'Stripe error: sk_live_secret' }), { status: 500 }); } });
  await assert.rejects(api.call('pay', {}, { token: 'test-token', write: true }), e => e.uncertain && !e.message.includes('sk_live'));
  assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer test-token');
  assert.throws(() => new EsimApi({ origin: 'http://evil.test' }), /HTTPS/);
});
