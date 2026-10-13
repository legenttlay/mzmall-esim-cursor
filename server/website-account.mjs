import { randomBytes, createHash } from 'node:crypto';

const hex = value => /^[a-f0-9]{64}$/.test(String(value ?? ''));
export class WebsiteAccountConnection {
  constructor({ api, store, now = () => Date.now() }) { Object.assign(this, { api, store, now }); }
  async begin(base) {
    const callback = new URL('/account-callback', base);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port) throw new Error('Invalid local callback');
    const state = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url');
    const record = { verifier, callback_url: callback.href, expires: this.now() + 600000, status: 'starting' };
    this.store.put('website-connection', state, record);
    const started = await this.api.call('agent_connect_start', {
      redirect_uri: callback.href, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }, { write: true });
    const url = new URL(started.authorization_url), origin = this.api.origin ?? 'https://888688889.com';
    if (url.origin !== origin || url.pathname !== '/index.php/Home/API/EsimApi/agent_connect_page.html' || url.username || url.password || url.hash
        || !hex(started.connection_id) || url.searchParams.get('connection') !== started.connection_id
        || [...url.searchParams.keys()].some(k => k !== 'connection') || url.searchParams.getAll('connection').length !== 1) throw new Error('Invalid website connection link');
    record.connection_id = started.connection_id; record.status = 'ready';
    this.store.put('website-connection', state, record);
    return url.href;
  }
  async complete(params, callbackUrl) {
    const state = params.get('state');
    if (!hex(state) || params.getAll('state').length !== 1 || [...params.keys()].some(k => !['state', 'code', 'error'].includes(k))) throw new Error('Invalid account connection callback');
    return this.store.locked(`website-connect:${state}`, async () => {
      const record = this.store.get('website-connection', state);
      if (!record || record.expires <= this.now() || record.callback_url !== callbackUrl || record.status !== 'ready') throw new Error('Account connection expired or interrupted. Request a new link from Cursor.');
      if (params.get('error') === 'access_denied' && !params.has('code') && params.getAll('error').length === 1) {
        this.store.delete('website-connection', state);
        return { connected: false, cancelled: true };
      }
      const code = params.get('code');
      if (!hex(code) || params.getAll('code').length !== 1 || params.has('error')) throw new Error('Invalid account connection callback');
      record.status = 'exchange_started'; this.store.put('website-connection', state, record);
      const login = await this.api.call('agent_connect_exchange', { code, code_verifier: record.verifier, redirect_uri: record.callback_url }, { write: true });
      if (!login.token || !Number.isSafeInteger(Number(login.uid)) || Number(login.uid) < 1) throw new Error('Account connection failed');
      const verified = await this.api.call('user_info', {}, { token: login.token });
      if (Number(verified.uid) !== Number(login.uid)) throw new Error('Account connection identity did not match');
      this.store.put('account', 'current', { token: login.token, uid: Number(verified.uid), expire_time: login.expire_time });
      this.store.delete('website-connection', state);
      return { connected: true };
    });
  }
}
