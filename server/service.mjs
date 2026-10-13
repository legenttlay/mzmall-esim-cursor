import { randomUUID, createHash } from 'node:crypto';
import { productView, orderView } from './api.mjs';

const money = v => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error('Invalid price'); return Math.round(n * 100) / 100; };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class EsimService {
  constructor({ api, store, purchasesEnabled = false, now = () => Date.now() }) { Object.assign(this, { api, store, purchasesEnabled, now }); }
  async search(args) {
    const d = await this.api.call('products', { country_code: args.country_code, kw: args.keyword, category: 'esim', page: args.page ?? 1, sort: 'price_asc', days: args.validity_days });
    return { products: (d.list ?? []).filter(p => p.category === 'esim').map(productView), page: d.page, pages: d.pages, total: d.total };
  }
  async product(id) {
    const d = await this.api.call('product', { id });
    if (d.product?.category !== 'esim') throw new Error('Only digital eSIM products are supported');
    return productView(d.product);
  }
  async auth() {
    const token = this.store.get('account', 'current')?.token;
    if (!token) throw new Error('Connect your own MZ MALL account using connect_esim_account. Never paste a password, OTP or bearer token into chat.');
    const user = await this.api.call('user_info', {}, { token });
    if (!Number.isSafeInteger(Number(user.uid)) || Number(user.uid) < 1) throw new Error('Invalid account identity');
    return { token, uid: Number(user.uid), email: user.email, balance: money(user.cash) };
  }
  async prepare(args) {
    if (!this.purchasesEnabled) throw new Error('Purchasing is not enabled for this installation. Catalog browsing is available.');
    const a = await this.auth();
    const key = `${a.uid}:${args.request_id}`, hash = fingerprint(args);
    return this.store.locked(`create:${key}`, async () => {
      let q = this.store.get('purchase', key);
      if (q) {
        if (q.hash !== hash) throw new Error('A request ID cannot be reused with different purchase details');
        if (!q.order_id) throw new Error('Order creation was interrupted. Check account orders; do not submit a replacement automatically.');
        if (q.payment_attempted) return this.status(q.purchase_id, false);
        return this.publicPurchase(q);
      }
      const p = await this.product(args.product_id), total = money(p.unit_price * args.quantity);
      if (total <= 0 || total > args.max_total_mmk) throw new Error('Current price exceeds the approved budget or is invalid. Obtain a new quote.');
      q = { purchase_id: randomUUID(), uid: a.uid, hash, request_id: args.request_id, product: p, email: args.email,
        quantity: args.quantity, total, created_at: this.now(), state: 'creating' };
      this.store.put('purchase', key, q);
      this.store.put('purchase-index', q.purchase_id, { key });
      try {
        const order = await this.api.call('order_create', { product_id: args.product_id, quantity: args.quantity, email: args.email, fulfillment_type: 'esim', days: 1 }, { token: a.token, write: true });
        q.order_id = Number(order.order_id); q.order_number = order.order_num; q.state = 'unpaid';
        if (!Number.isSafeInteger(q.order_id) || q.order_id < 1) throw new Error('Invalid order confirmation');
        q.actual_total = money(order.price);
        if (q.actual_total !== total) q.state = 'price_changed';
        this.store.put('purchase', key, q);
      } catch (e) { q.state = 'creation_unknown'; this.store.put('purchase', key, q); throw e; }
      return this.publicPurchase(q);
    });
  }
  publicPurchase(q) {
    return { purchase_id: q.purchase_id, order_id: q.order_id, order_number: q.order_number, state: q.state,
      product: q.product, quantity: q.quantity, delivery_email: q.email, total: q.actual_total ?? q.total, currency: 'MMK',
      payment_completed: false, note: q.state === 'price_changed' ? 'Order price changed. This purchase is blocked; do not pay it.' : 'An unpaid order exists. No payment or eSIM issuance has been confirmed.' };
  }
  async owned(id) {
    const a = await this.auth(), index = this.store.get('purchase-index', id);
    const q = index && this.store.get('purchase', index.key);
    if (!q || q.uid !== a.uid) throw new Error('Purchase not found for the connected account');
    return { a, q, key: index.key };
  }
  async quote(id, method) {
    const { a, q } = await this.owned(id);
    if (!q.order_id || q.state === 'price_changed') throw new Error('This purchase cannot be paid');
    const detail = await this.api.call('order_detail', { order_id: q.order_id }, { token: a.token });
    if (Number(detail.order.is_pay) === 1) return { already_paid: true };
    if (money(detail.order.true_price ?? detail.order.price) !== q.total) throw new Error('Order price changed. Obtain a new approval before purchase.');
    const info = await this.api.call('pay_info', { order_id: q.order_id }, { token: a.token });
    if (money(info.price) !== q.total) throw new Error('Payment price changed');
    const methodId = method === 'balance' ? '2' : '13', m = info.methods?.find(m => String(m.id) === methodId);
    if (!m) throw new Error('Requested payment method is unavailable');
    let total = q.total, currency = 'MMK';
    if (method === 'balance') { if (money(m.balance) < total) throw new Error('Insufficient balance'); }
    else {
      const fx = await this.api.call('exchange_rate');
      if (!(Number(fx.cny_rate) > 0)) throw new Error('Card currency conversion is unavailable');
      const factor = 1 + Number(m.fee_pct_base ?? m.fee_pct ?? 0) / 100;
      total = money((q.total * factor + Number(m.fee_fixed_mmk ?? 0)) / Number(fx.cny_rate)); currency = 'CNY';
    }
    return { purchase_id: id, order_id: q.order_id, product: q.product.name, quantity: q.quantity, delivery_email: q.email,
      payment_method: method, total, currency, base_total_mmk: q.total,
      card_amount_is_estimate: method === 'card',
      terms: 'An unlocked eSIM-compatible device is required. Paid eSIM cancellations are not supported by this API; contact merchant support for refund eligibility. Card checkout displays the final amount before authorization.' };
  }
  async pay(id, method, approve) {
    if (!this.purchasesEnabled) throw new Error('Purchasing is not enabled for this installation.');
    const { a, q, key } = await this.owned(id);
    return this.store.locked(`pay:${a.uid}:${q.order_id}`, async () => {
      const saved = this.store.get('purchase', key);
      const attemptKey = `${a.uid}:${q.order_id}`;
      const previous = this.store.get('payment-attempt', attemptKey) ?? saved;
      if (previous.payment_attempted) {
        const status = await this.status(id, false);
        if (status.paid) return status;
        if (previous.checkout_url && previous.payment_method === method) return { ...status, checkout_url: previous.checkout_url };
        return { ...status, state: 'payment_unknown', note: 'A payment was already attempted. Do not retry or change payment method until the merchant resolves it.' };
      }
      if (this.now() - q.created_at > 15 * 60 * 1000) throw new Error('Purchase quote expired. Check your orders before preparing another purchase.');
      const quote = await this.quote(id, method);
      if (quote.already_paid) return this.status(id, false);
      if (!(await approve(quote))) return { purchase_id: id, state: 'approval_required', payment_completed: false };
      const current = await this.quote(id, method);
      if (current.already_paid) return this.status(id, false);
      if (fingerprint(current) !== fingerprint(quote)) throw new Error('Payment terms changed after approval. A new approval is required.');
      saved.payment_attempted = true; saved.payment_method = method; saved.state = 'payment_unknown';
      this.store.put('payment-attempt', attemptKey, saved);
      this.store.put('purchase', key, saved);
      try {
        const result = await this.api.call('pay', { order_id: q.order_id, paystyle: method === 'balance' ? '2' : '13', platform: 'h5', pay_client: 'web' }, { token: a.token, write: true });
        if (method === 'card') {
          const u = new URL(result.redirect_url);
          if (u.protocol !== 'https:' || u.hostname !== 'checkout.stripe.com' || u.username || u.password) throw new Error('Unexpected secure checkout URL');
          saved.checkout_url = u.href; saved.state = 'awaiting_secure_payment';
        } else saved.state = 'awaiting_fulfillment';
        this.store.put('payment-attempt', attemptKey, saved);
        this.store.put('purchase', key, saved);
      } catch (e) { throw new Error('Payment outcome is not confirmed. Check this purchase status; do not pay again.'); }
      const status = await this.status(id, false);
      return { ...status, ...(saved.checkout_url ? { checkout_url: saved.checkout_url, note: 'Complete card verification in this secure checkout. A checkout link is not a paid receipt.' } : {}) };
    });
  }
  async status(id, deliver = false) {
    const { a, q } = await this.owned(id);
    if (!q.order_id) return { purchase_id: id, state: 'creation_unknown', paid: false, fulfilled: false };
    const d = await this.api.call('order_detail', { order_id: q.order_id }, { token: a.token });
    const o = orderView(d.order), all = Array.isArray(d.cards) ? d.cards : [];
    // Never forward raw supplier/card rows. They contain PINs, credentials and
    // unrelated fields. Delivery credentials are released only on request.
    const ready = all.filter(c => typeof c.qrcode_content === 'string' && /^LPA:1\$[^\r\n]+\$[^\r\n]+$/.test(c.qrcode_content));
    const closed = o.paid && o.provider_status < 0;
    const fulfilled = o.paid && !closed && ready.length >= q.quantity;
    const state = !o.paid ? 'unpaid' : closed ? 'paid_requires_merchant_review' : fulfilled ? 'delivered' : 'paid_awaiting_fulfillment';
    const result = { purchase_id: id, ...o, state, fulfilled, cards_ready: o.paid ? ready.length : 0 };
    if (deliver && o.paid && !closed) {
      result.esims = ready.slice(0, q.quantity).map(c => ({ activation_code: c.qrcode_content, iccid: String(c.iccid ?? ''), instructions: o.activation_guide }));
      result.note = fulfilled ? 'Keep these installation credentials private. Delivery does not prove device installation or network activation.' : 'Payment is confirmed, but not all eSIMs have been delivered. Do not purchase again.';
    }
    return result;
  }
  async orders() {
    const a = await this.auth(), d = await this.api.call('orders', { page: 1, fulfillment_type: 'esim' }, { token: a.token });
    return { orders: (d.list ?? d.orders ?? []).map(orderView), page: d.page, pages: d.pages };
  }
}
