const ACTIONS = new Set(['search', 'products', 'product', 'exchange_rate', 'user_info', 'send_email_code', 'login_email', 'logout', 'order_create', 'pay_info', 'pay', 'order_detail', 'orders', 'agent_connect_start', 'agent_connect_exchange']);
export class ApiError extends Error {
  constructor(message, uncertain = false) { super(message); this.uncertain = uncertain; }
}
export class EsimApi {
  constructor({ origin = 'https://888688889.com', fetchImpl = fetch, allowLocal = false } = {}) {
    const u = new URL(origin);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || (u.protocol !== 'https:' && !(allowLocal && ['localhost', '127.0.0.1'].includes(u.hostname)))) throw new Error('API origin must be a trusted HTTPS origin');
    this.origin = u.origin; this.fetch = fetchImpl;
  }
  async call(action, params = {}, { token = '', write = false } = {}) {
    if (!ACTIONS.has(action)) throw new Error('Unsupported API action');
    const url = new URL(`/index.php/Home/API/EsimApi/${action}.html`, this.origin);
    const options = { method: write ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(25000), headers: { 'Accept': 'application/json', 'X-Lang': 'en' } };
    if (token) options.headers.Authorization = `Bearer ${token}`;
    if (write) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(params); }
    else for (const [k, v] of Object.entries({ ...params, lang: 'en' })) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let response;
    try { response = await this.fetch(url, options); }
    catch { throw new ApiError(write ? 'The result of the submitted request is unknown. Check status before any further action.' : 'The eSIM service could not be reached.', write); }
    let body;
    try { body = await response.json(); } catch { throw new ApiError('Invalid service response. Do not retry a purchase automatically.', write); }
    if (!response.ok || Number(body.code) !== 1) {
      // Never forward raw upstream exceptions, which can contain gateway URLs,
      // credential fragments or internal SQL. Specific safe customer errors only.
      const allowed = /^(Insufficient balance|Already paid|Product not found|Order not found|Email is required|Invalid email|Invalid or expired.*code|Invalid verification code|Too many.*|Please wait.*|Unauthorized|Not logged in|Unsupported payment method)$/i;
      const safe = allowed.test(String(body.msg)) ? String(body.msg) : action === 'send_email_code' && /^Failed to send email:/i.test(String(body.msg)) ? 'The email could not be sent. Please wait at least 60 seconds before trying again or contact MZ MALL support.' : 'The service rejected this request. Verify account, product and payment status before continuing.';
      throw new ApiError(safe, write && response.status >= 500);
    }
    return body.data;
  }
}

const text = (v, max = 4000) => String(v ?? '').replace(/<[^>]*>/g, '').slice(0, max);
export function productView(p) {
  return { product_id: Number(p.id), name: text(p.product_name, 250), category: p.category,
    country_code: text(p.country_code, 16), country: text(p.country_name, 100), coverage: text(p.coverage),
    coverage_countries: p.coverage_countries, data: text(p.data_fmt, 100), traffic_kind: p.traffic_kind,
    validity_days: Number(p.validity_days), plan_type: p.product_type, unit_price: Number(p.sell_price), currency: 'MMK',
    description: text(p.description_text), activation_guide: text(p.activation_guide),
    compatibility: 'An unlocked, eSIM-compatible device is required. Device-model compatibility is not verified by this API.' };
}
export function orderView(o) {
  return { order_id: Number(o.id), order_number: text(o.order_num, 100), product_id: Number(o.product_id),
    product: text(o.product_name, 250), quantity: Number(o.quantity), total: Number(o.true_price ?? o.price), currency: 'MMK',
    paid: Number(o.is_pay) === 1, provider_status: Number(o.status), activation_guide: text(o.activation_guide) };
}
