import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import QRCode from 'qrcode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.mjs';
import { EsimApi } from './api.mjs';
import { EsimService } from './service.mjs';
import { startPortal, quoteHash } from './portal.mjs';

export function makeServer({ service, portal, store }) {
  const server = new McpServer({ name: 'mzmall-esim', version: '0.3.0' });
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
  const id = z.string().uuid(), positive = z.number().int().positive();
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const tool = (name, config, callback) => server.registerTool(name, config, async (args, extra) => {
    try { return result(await callback(args, extra)); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  });
  tool('search_esim_plans', { description: 'Return a short selection of currently sellable eSIMs by destination and validity. Default is at most three options; present a compact comparison without internal IDs or a full catalog. Use limit=20 only when the customer requests more or all plans. Prices are MMK. No purchase or login.', inputSchema: { country_code: z.string().regex(/^[A-Z]{2}$/).optional(), keyword: z.string().max(100).optional(), validity_days: positive.optional(), page: positive.max(100).default(1), limit: positive.max(20).default(3) }, annotations: read }, args => service.search(args));
  tool('get_esim_plan', { description: 'Read a digital eSIM plan, retail price, coverage, data limits and activation instructions. Does not verify device compatibility.', inputSchema: { product_id: positive }, annotations: read }, args => service.product(args.product_id));
  const shoppingRequest = z.object({ intent: z.enum(['purchase', 'browse', 'connect_only']), country_code: z.string().regex(/^[A-Z]{2}$/).optional(), validity_days: positive.max(730).optional(), product_id: positive.optional(), quantity: positive.max(30).optional(), max_total_mmk: z.number().finite().nonnegative().optional(), data_preference: z.string().max(200).optional() }).strict();
  tool('connect_esim_account', { description: 'Return a private website login link valid for ten minutes. Preserve the customer’s current eSIM selection in shopping_request. Show the link, then call get_esim_account with its connection_id and wait_seconds=30 to resume this conversation after login. Never put OTPs or tokens in chat. Login does not authorize an order or payment.', inputSchema: { shopping_request: shoppingRequest.optional() }, annotations: { ...read, readOnlyHint: false, idempotentHint: false } }, async args => {
    const signInUrl = await portal.accountUrl(args.shopping_request);
    const connectionId = new URL(signInUrl).searchParams.get('connection');
    return { sign_in_url: signInUrl, ...(connectionId ? { connection_id: connectionId, expires_in_seconds: 600, next_step: 'Show the customer this link, then wait for the same connection with get_esim_account(connection_id, wait_seconds=30). Continue their original request after connection; obtain transaction approval before any payment.' } : {}) };
  });
  tool('get_esim_account', { description: 'Read the connected customer account and MMK balance without tokens. With connection_id, check or briefly wait for that exact website login and restore its shopping_request only for the verified account. A successful login is not payment approval.', inputSchema: { connection_id: z.string().regex(/^[a-f0-9]{64}$/).optional(), wait_seconds: z.number().int().min(0).max(30).default(0) }, annotations: read }, async (args, extra) => {
    let connection;
    if (args.wait_seconds && !args.connection_id) throw new Error('Use the connection_id returned by connect_esim_account when waiting for login.');
    if (args.connection_id) {
      const deadline = Date.now() + args.wait_seconds * 1000;
      do {
        connection = portal.connectionStatus(args.connection_id);
        if (connection.state !== 'awaiting_login' || Date.now() >= deadline) break;
        await delay(Math.min(500, deadline - Date.now()), undefined, { signal: extra?.signal });
      } while (true);
      if (connection.state !== 'connected') return { connected: false, state: connection.state, next_step: connection.state === 'awaiting_login' ? 'The customer is still signing in. Keep the same selection and connection ID. Continue waiting if they are completing login; do not create another login or an order.' : 'Return to the customer’s original request. A cancelled, expired or unknown connection may need a new sign-in link.' };
    }
    const a = await service.auth();
    if (connection && connection.uid !== a.uid) throw new Error('This connection belongs to a different account. Request a new connection for the current customer.');
    return { connected: true, account_id: a.uid, email: a.email, balance: a.balance, currency: 'MMK', ...(portal.managementUrl ? { account_management_url: portal.managementUrl() } : {}), ...(connection?.shopping_request ? { shopping_request: connection.shopping_request, next_step: 'Resume this saved request. Re-read the selected plan and confirm current price and delivery details. Connecting is not consent to create an order or pay.' } : {}) };
  });
  tool('prepare_esim_purchase', { description: 'Create or reuse the customer-requested unpaid eSIM order. Default quantity is one and default delivery is the verified account email, so do not ask again for known details. Set max_total_mmk to the quoted total the customer accepted; do not request a separate maximum budget after they agree to that price. An earlier do-not-order request still applies until explicitly changed. Does not charge or issue eSIMs. Reuse the same request_id after interruption.', inputSchema: { product_id: positive, quantity: positive.max(30).default(1), email: z.string().email().max(254).optional(), max_total_mmk: z.number().positive().finite(), request_id: z.string().min(8).max(80).regex(/^[A-Za-z0-9_.:-]+$/) }, annotations: write }, args => service.prepare(args));
  tool('get_esim_payment_quote', { description: 'Read the exact balance-payment total or a card-checkout estimate including fees and currency conversion. The upstream order read may reconcile an existing payment. Card checkout displays the final amount. Does not start a payment.', inputSchema: { purchase_id: id, payment_method: z.enum(['balance', 'card']) }, annotations: { ...read, readOnlyHint: false } }, args => service.quote(args.purchase_id, args.payment_method));
  tool('open_esim_card_checkout', { description: 'Create or reuse secure Stripe card checkout for the existing customer-requested eSIM order. Use after the customer chooses card payment. This only opens checkout; the customer confirms the final amount and payment at Stripe. No separate plugin approval page is needed. A link is not payment confirmation. Never ask for card details in chat or recreate an order after an unknown attempt.', inputSchema: { purchase_id: id }, annotations: { ...read, readOnlyHint: false } }, args => service.openCardCheckout(args.purchase_id));
  tool('pay_esim_purchase', { description: 'SENSITIVE BALANCE PAYMENT: pay the specific eSIM order only after the host or private page obtains fresh approval of its details. Avoid an extra chat confirmation before this final approval. For card payment prefer open_esim_card_checkout; the legacy card argument only opens the same secure checkout. Unknown results must be checked, never retried blindly.', inputSchema: { purchase_id: id, payment_method: z.enum(['balance', 'card']) }, annotations: write }, async args => {
    if (args.payment_method === 'card') return service.openCardCheckout(args.purchase_id);
    let approvalUrl;
    const value = await service.pay(args.purchase_id, args.payment_method, async quote => {
      const approval = store.get('approval', args.purchase_id), a = await service.auth();
      if (approval?.uid === a.uid && approval.expires > Date.now() && approval.hash === quoteHash(quote)) { store.delete('approval', args.purchase_id); return true; }
      const caps = server.server.getClientCapabilities();
      if (caps?.elicitation && ('form' in caps.elicitation || Object.keys(caps.elicitation).length === 0)) {
        const answer = await server.server.elicitInput({ mode: 'form', message: `MZ MALL eSIM：${quote.product} × ${quote.quantity}，${quote.total} ${quote.currency}；余额付款，发送至 ${quote.delivery_email}。需支持 eSIM 的解锁设备；退款请联系客服确认。`, requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: '确认这笔余额付款', default: false } }, required: ['approve'] } });
        return answer.action === 'accept' && answer.content?.approve === true;
      }
      approvalUrl = portal.approvalUrl(args.purchase_id, args.payment_method);
      return false;
    });
    return { ...value, ...(approvalUrl ? { approval_url: approvalUrl } : {}) };
  });
  tool('get_esim_purchase_status', { description: 'Check merchant-confirmed payment and eSIM fulfillment. This upstream read can reconcile an existing paid transaction. It does not start a new payment. No installation credentials are returned.', inputSchema: { purchase_id: id }, annotations: { ...read, readOnlyHint: false } }, args => service.status(args.purchase_id, false));
  server.registerTool('get_esim_delivery', { description: 'Retrieve private installation codes and QR images for this customer’s paid eSIM purchase. Only report complete delivery when every ordered eSIM is ready; delivery does not prove installation or network activation.', inputSchema: { purchase_id: id }, annotations: { ...read, readOnlyHint: false } }, async args => {
    try {
      const d = await service.status(args.purchase_id, true), content = [{ type: 'text', text: JSON.stringify(d) }];
      for (const card of d.esims ?? []) content.push({ type: 'image', data: (await QRCode.toBuffer(card.activation_code, { type: 'png', margin: 2, width: 320 })).toString('base64'), mimeType: 'image/png' });
      return { content, structuredContent: d };
    } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  });
  tool('list_my_esim_orders', { description: 'Read the first page of this customer’s eSIM orders to recover interrupted purchases. No card credentials are returned.', inputSchema: {}, annotations: read }, () => service.orders());
  return server;
}

async function main() {
  const store = new Store(process.env.MZMALL_DATA_DIR || join(homedir(), '.mzmall-esim'));
  const api = new EsimApi();
  const service = new EsimService({ api, store, purchasesEnabled: process.env.MZMALL_ENABLE_PURCHASES === '1' });
  const portal = await startPortal({ api, store, service, websiteLogin: true });
  const server = makeServer({ service, portal, store });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; portal.server.close(); await server.close(); store.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.stdin.on('end', stop);
}
if (process.argv[1]?.endsWith('main.mjs') || process.argv[1]?.endsWith('index.mjs')) main().catch(e => {
  const code = /^[A-Z0-9_]{1,40}$/.test(String(e.code)) ? e.code : 'STARTUP_ERROR';
  // Diagnostic codes only: never print paths, vault contents or raw exceptions.
  console.error(`MZ MALL eSIM startup failed (${code}, Node ${process.version}). Check runtime and local vault access.`);
  process.exitCode = 1;
});
