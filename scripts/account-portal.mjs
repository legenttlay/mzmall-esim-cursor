import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { EsimApi } from '../server/api.mjs';
import { EsimService } from '../server/service.mjs';
import { startPortal } from '../server/portal.mjs';

// Account connection only. This helper has no purchase command and performs
// no email delivery, order creation or payment. Website authorization is manual.
const store = new Store(join(homedir(), '.mzmall-esim'));
const api = new EsimApi();
const service = new EsimService({ api, store, purchasesEnabled: false });
// Optional loopback port lets a restarted helper reuse the user's open address.
const portal = await startPortal({ api, store, service, port: Number(process.argv[2] ?? 0), websiteLogin: true });
console.log(JSON.stringify({ status_url: portal.statusUrl(), ...(!store.get('account', 'current') ? { sign_in_url: await portal.accountUrl() } : {}), account_connection_only: true, created_orders: 0, payments: 0 }));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  portal.server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
