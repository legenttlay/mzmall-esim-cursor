import { EsimApi, productView } from '../server/api.mjs';
const api = new EsimApi();
const catalog = await api.call('products', { country_code: 'TH', category: 'esim', page: 1, sort: 'price_asc' });
const first = catalog.list?.find(p => p.category === 'esim');
if (!first) throw new Error('No live Thailand eSIM returned');
const detail = await api.call('product', { id: Number(first.id) });
const p = productView(detail.product);
if (!(p.unit_price > 0) || p.category !== 'esim') throw new Error('Invalid live retail product');
console.log(JSON.stringify({ read_only: true, created_orders: 0, payments: 0, product: p, total: catalog.total, checked_at: new Date().toISOString() }, null, 2));
