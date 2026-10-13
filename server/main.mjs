import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import QRCode from 'qrcode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { EsimApi } from './api.mjs';
import { EsimService } from './service.mjs';
import { startPortal, quoteHash } from './portal.mjs';

export function makeServer({ service, portal, store }) {
  const server = new McpServer({ name: 'mzmall-esim', version: '0.1.1' });
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
  const id = z.string().uuid(), positive = z.number().int().positive();
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const tool = (name, config, callback) => server.registerTool(name, config, async args => {
    try { return result(await callback(args)); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
  });
  tool('search_esim_plans', { description: 'Search currently sellable digital eSIM plans by destination, keyword and exact validity. Prices are MMK retail prices. No purchase or login.', inputSchema: { country_code: z.string().regex(/^[A-Z]{2}$/).optional(), keyword: z.string().max(100).optional(), validity_days: positive.optional(), page: positive.max(100).default(1) }, annotations: read }, args => service.search(args));
  tool('get_esim_plan', { description: 'Read a digital eSIM plan, retail price, coverage, data limits and activation instructions. Does not verify device compatibility.', inputSchema: { product_id: positive }, annotations: read }, args => service.product(args.product_id));
  tool('connect_esim_account', { description: 'Return a private local browser sign-in page. The customer enters email and OTP there, never in chat. Sign-in may create an account for a new email.', inputSchema: {}, annotations: read }, async () => ({ sign_in_url: portal.accountUrl() }));
  tool('get_esim_account', { description: 'Read the connected customer account and MMK balance; does not expose login tokens.', inputSchema: {}, annotations: read }, async () => { const a = await service.auth(); return { account_id: a.uid, email: a.email, balance: a.balance, currency: 'MMK' }; });
  tool('prepare_esim_purchase', { description: 'Create or reuse an unpaid digital eSIM order. Use only when the customer wants to buy the specified plan, quantity and delivery email within the stated MMK budget. Does not charge or issue eSIMs. Reuse the same request_id after interruption.', inputSchema: { product_id: positive, quantity: positive.max(30), email: z.string().email().max(254), max_total_mmk: z.number().positive().finite(), request_id: z.string().min(8).max(80).regex(/^[A-Za-z0-9_.:-]+$/) }, annotations: write }, args => service.prepare(args));
  tool('get_esim_payment_quote', { description: 'Read the exact balance-payment total or a card-checkout estimate including fees and currency conversion. The upstream order read may reconcile an existing payment. Card checkout displays the final amount. Does not start a payment.', inputSchema: { purchase_id: id, payment_method: z.enum(['balance', 'card']) }, annotations: { ...read, readOnlyHint: false } }, args => service.quote(args.purchase_id, args.payment_method));
  tool('pay_esim_purchase', { description: 'SENSITIVE PURCHASE: pay the customer-approved eSIM order from their balance, or open secure card checkout. Requires fresh approval of the complete details. A checkout link does not prove payment. Unknown outcomes must be checked and never retried blindly. Never ask for card numbers or bank credentials in chat.', inputSchema: { purchase_id: id, payment_method: z.enum(['balance', 'card']) }, annotations: write }, async args => {
    let approvalUrl;
    const value = await service.pay(args.purchase_id, args.payment_method, async quote => {
      const approval = store.get('approval', args.purchase_id), a = await service.auth();
      if (approval?.uid === a.uid && approval.expires > Date.now() && approval.hash === quoteHash(quote)) { store.delete('approval', args.purchase_id); return true; }
      const caps = server.server.getClientCapabilities();
      if (caps?.elicitation && ('form' in caps.elicitation || Object.keys(caps.elicitation).length === 0)) {
        const answer = await server.server.elicitInput({ mode: 'form', message: `Approve MZ MALL eSIM purchase: ${quote.product} × ${quote.quantity}, ${quote.total} ${quote.currency}, payment: ${quote.payment_method}, delivery: ${quote.delivery_email}. ${quote.terms}`, requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Approve this specific purchase', default: false } }, required: ['approve'] } });
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
  const portal = await startPortal({ api, store, service });
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
