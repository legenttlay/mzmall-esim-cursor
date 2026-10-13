import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const quoteHash = q => createHash('sha256').update(JSON.stringify(q)).digest('hex');
export async function startPortal({ api, store, service, port = 0 }) {
  const nonce = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  let base;
  const shell = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px system-ui;background:#f4f6fb;color:#16253c;margin:0;padding:32px}main{max-width:580px;margin:auto;background:white;border-radius:16px;padding:28px}h1{font-size:24px}label{display:block;margin-top:16px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aab5c3;border-radius:8px}button{background:#164aaf;color:white;border:0;border-radius:8px;padding:12px 18px;margin-top:16px;cursor:pointer}p{line-height:1.6}.muted{color:#526174}a{color:#164aaf}</style><main><p class="muted">MZ MALL eSIM · Private account connection</p><h1>${escape(title)}</h1>${body}</main></html>`;
  const form = (action, fields, label) => `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}">${fields}<button>${label}</button></form>`;
  const loginForm = email => form('/send-code', '<label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>', 'Send verification code') + form('/login', `<label>Email<input name="email" type="email" autocomplete="email" required maxlength="254" value="${escape(email)}"></label><label>Verification code<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required maxlength="6"></label>`, 'Connect my account') + '<p class="muted">A new email may create a website account. Verification codes and login tokens stay out of Cursor chat. Your account is connected only to this OS user’s local plugin.</p>';
  const server = createServer(async (req, res) => {
    // Native form POSTs need their real Origin for the strict check below.
    // same-origin suppresses referrers to other sites without turning this Origin into null.
    const send = (status, html) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); res.end(html); };
    try {
      if (req.headers.host !== new URL(base).host) return send(403, 'Forbidden host');
      const u = new URL(req.url, base), cookies = String(req.headers.cookie ?? '').split(';').map(s => s.trim());
      if (req.method === 'GET' && u.searchParams.get('session') === nonce) {
        res.writeHead(303, { Location: u.pathname + (u.searchParams.has('purchase') ? `?purchase=${encodeURIComponent(u.searchParams.get('purchase'))}&method=${encodeURIComponent(u.searchParams.get('method') ?? 'balance')}` : ''), 'Set-Cookie': `mz_esim_session=${nonce}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      if (!cookies.includes(`mz_esim_session=${nonce}`)) return send(403, shell('Open from Cursor', '<p>Use the account or approval link returned by your eSIM plugin.</p>'));
      if (req.method === 'GET' && u.pathname === '/') {
        let connected = '';
        if (store.get('account', 'current')) {
          try { const a = await service.auth(); connected = `<p>Connected account: ${escape(a.email)} · Balance: ${a.balance} MMK.</p>` + form('/disconnect', '', 'Disconnect'); } catch { connected = '<p>Your session expired. Sign in again.</p>'; }
        }
        return send(200, shell('Connect your eSIM account', connected + loginForm('')));
      }
      if (req.method === 'GET' && u.pathname === '/approve') {
        const method = u.searchParams.get('method');
        if (!['balance', 'card'].includes(method)) return send(400, 'Invalid payment method');
        const q = await service.quote(u.searchParams.get('purchase'), method);
        if (q.already_paid) return send(200, shell('Already paid', '<p>Return to Cursor and check delivery. Do not pay again.</p>'));
        const ticket = randomBytes(24).toString('hex');
        store.put('approval-ticket', ticket, { quote: q, hash: quoteHash(q), expires: Date.now() + 120000 });
        const body = `<p>${escape(q.product)} × ${q.quantity}</p><p><strong>${q.total} ${q.currency}</strong> · ${escape(method)}</p><p>Delivery email: ${escape(q.delivery_email)}</p><p>${escape(q.terms)}</p><p>${method === 'card' ? 'This approves opening secure card checkout. The final charge requires your authorization in that checkout.' : 'This authorizes this exact purchase from your MZ MALL account balance.'}</p>` + form('/approve', `<input type="hidden" name="ticket" value="${ticket}">`, 'Approve this purchase');
        return send(200, shell('Review this purchase', body));
      }
      if (req.method !== 'POST' || req.headers.origin !== base) return send(403, 'Forbidden origin');
      let raw = '';
      for await (const part of req) { raw += part; if (raw.length > 4096) return send(413, 'Request too large'); }
      const body = new URLSearchParams(raw);
      if (body.get('csrf') !== csrf) return send(403, 'Invalid form session');
      if (u.pathname === '/send-code' || u.pathname === '/login') {
        const email = String(body.get('email') ?? '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return send(400, 'Invalid email');
        if (u.pathname === '/send-code') {
          await api.call('send_email_code', { email }, { write: true });
          return send(200, shell('Check your email', '<p>Enter the code below to connect your account.</p>' + loginForm(email)));
        }
        const code = String(body.get('code') ?? '');
        if (!/^[0-9]{6}$/.test(code)) return send(400, 'Invalid verification code');
        const login = await api.call('login_email', { email, code }, { write: true });
        if (!login.token) throw new Error('Account connection failed');
        const verified = await api.call('user_info', {}, { token: login.token });
        store.put('account', 'current', { token: login.token, uid: verified.uid, expire_time: login.expire_time });
        return send(200, shell('Account connected', '<p>Return to Cursor. The plugin can now access your own eSIM account.</p>'));
      }
      if (u.pathname === '/disconnect') {
        const token = store.get('account', 'current')?.token;
        store.delete('account', 'current');
        if (token) { try { await api.call('logout', {}, { token, write: true }); } catch {} }
        return send(200, shell('Disconnected', '<p>This plugin no longer has your account login. Transaction records remain for recovery and audit.</p>'));
      }
      if (u.pathname === '/approve') {
        const ticket = body.get('ticket'), saved = store.get('approval-ticket', ticket);
        if (!saved || saved.expires < Date.now()) return send(400, 'Approval expired. Return to Cursor for a new quote.');
        const current = await service.quote(saved.quote.purchase_id, saved.quote.payment_method);
        if (quoteHash(current) !== saved.hash) return send(409, 'The purchase changed. Return to Cursor for a new quote.');
        const owner = await service.auth();
        store.put('approval', saved.quote.purchase_id, { hash: saved.hash, uid: owner.uid, expires: Date.now() + 120000 });
        store.delete('approval-ticket', ticket);
        return send(200, shell('Purchase approved', '<p>Return to Cursor and ask it to continue this same purchase. This page has not charged you.</p>'));
      }
      return send(404, 'Not found');
    } catch (e) { return send(400, shell('Unable to continue', `<p>${escape(e.message)}</p>`)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, accountUrl: () => `${base}/?session=${nonce}`, approvalUrl: (id, method) => `${base}/approve?session=${nonce}&purchase=${encodeURIComponent(id)}&method=${method}` };
}
