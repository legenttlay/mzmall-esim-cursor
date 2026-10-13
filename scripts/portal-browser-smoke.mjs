import { fixture } from '../tests/fixture.mjs';
import { startPortal } from '../server/portal.mjs';

// Browser form verification against a mock API and an isolated temporary vault.
// This never sends email or connects to the merchant's production service.
const f = fixture();
f.store.delete('account', 'current');
const portal = await startPortal({ api: f.api, store: f.store, service: f.service });
portal.server.prependListener('request', (req, res) => {
  if (req.method !== 'POST') return;
  res.once('finish', () => console.log(JSON.stringify({
    test_only: true,
    path: new URL(req.url, portal.base).pathname,
    origin: req.headers.origin === portal.base ? 'same-origin' : req.headers.origin === 'null' ? 'null' : req.headers.origin ? 'other' : 'missing',
    status: res.statusCode,
    mock_email_calls: f.state.calls.filter(c => c.action === 'send_email_code').length,
    mock_login_calls: f.state.calls.filter(c => c.action === 'login_email').length,
    created_orders: f.state.count,
    payments: f.state.payCalls,
  })));
});
console.log(JSON.stringify({ test_only: true, sign_in_url: portal.accountUrl() }));
const stop = () => portal.server.close(() => { f.close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
