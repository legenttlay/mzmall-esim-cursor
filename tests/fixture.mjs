import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { EsimService } from '../server/service.mjs';
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mzmall-esim-test-'));
  const store = new Store(directory);
  store.put('account', 'current', { token: 'test-user-token', uid: 1 });
  const state = { uid: 1, price: 1000, balance: 9000, count: 0, payCalls: 0, paid: false, cards: [], status: -1, calls: [] };
  const api = { async call(action, params, options) {
    state.calls.push({ action, params, options });
    if (state.before) await state.before(action);
    if (action === 'user_info') return { uid: state.uid, email: 'buyer@example.test', cash: state.balance };
    if (action === 'product') return { product: { id: 101, product_name: 'Thailand 1GB', category: 'esim', sell_price: state.price, validity_days: 7, product_type: 'total', data_fmt: '1GB', country_code: 'TH', cost_price: 17, supplier_secret: 'must-not-return' } };
    if (action === 'products') return { list: [(await this.call('product')).product], page: 1, pages: 1, total: 1 };
    if (action === 'order_create') { state.count++; state.quantity = params.quantity; return { order_id: 700, order_num: 'ES-TEST-700', price: state.createdPrice ?? state.price * params.quantity }; }
    if (action === 'order_detail') return { order: { id: 700, order_num: 'ES-TEST-700', product_id: 101, product_name: 'Thailand 1GB', quantity: state.quantity, true_price: state.orderPrice ?? 1000 * state.quantity, is_pay: state.paid ? 1 : 0, status: state.status, activation_guide: 'Scan once on an unlocked compatible device', private_note: 'hidden' }, cards: state.cards };
    if (action === 'pay_info') return { price: state.orderPrice ?? 1000 * state.quantity, methods: [{ id: '2', balance: state.balance }, { id: '13', fee_pct_base: 3, fee_fixed_mmk: 100 }] };
    if (action === 'exchange_rate') return { cny_rate: 500, stripe_fl: 1.03 };
    if (action === 'pay') {
      state.payCalls++;
      if (state.payError) { if (state.paidBeforeError) state.paid = true; throw new Error('Network timeout'); }
      if (params.paystyle === '13') return { redirect_url: state.checkoutUrl ?? 'https://checkout.stripe.com/c/pay/test-only' };
      state.paid = true; state.status = 0; return { paid: true, order_id: 700 };
    }
    if (action === 'orders') return { list: [(await this.call('order_detail')).order], page: 1, pages: 1 };
    if (action === 'logout' || action === 'send_email_code') return {};
    if (action === 'login_email') return { token: 'test-login-token', user: { uid: 1 } };
    throw new Error(`Unexpected fixture action: ${action}`);
  } };
  const service = new EsimService({ api, store, purchasesEnabled: true });
  return { store, directory, api, service, state, close: () => store.close() };
}
export const purchaseArgs = { product_id: 101, quantity: 1, email: 'buyer@example.test', max_total_mmk: 1000, request_id: 'test-request-0001' };
