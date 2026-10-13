import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { WebsiteAccountConnection } from './website-account.mjs';

const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const quoteHash = q => createHash('sha256').update(JSON.stringify(q)).digest('hex');
export async function startPortal({ api, store, service, port = 0, websiteLogin = false }) {
  const nonce = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  let base, cookieName;
  let loginEmail = '', loginNotice = '';
  const sendCooldowns = new Map();
  const websiteConnection = websiteLogin ? new WebsiteAccountConnection({ api, store }) : null;
  const shell = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px system-ui;background:#f4f6fb;color:#16253c;margin:0;padding:32px}main{max-width:580px;margin:auto;background:white;border-radius:16px;padding:28px}h1{font-size:24px}label{display:block;margin-top:16px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aab5c3;border-radius:8px}button{background:#164aaf;color:white;border:0;border-radius:8px;padding:12px 18px;margin-top:16px;cursor:pointer}p{line-height:1.6}.muted{color:#526174}a{color:#164aaf}</style><main><p class="muted">MZ MALL eSIM · Private account connection</p><h1>${escape(title)}</h1>${body}</main></html>`;
  const form = (action, fields, label) => `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}">${fields}<button>${label}</button></form>`;
  const loginForm = email => form('/send-code', `<label>Email<input name="email" type="email" autocomplete="email" required maxlength="254" value="${escape(email)}"></label>`, 'Send verification code') + form('/login', `<label>Email<input name="email" type="email" autocomplete="email" required maxlength="254" value="${escape(email)}"></label><label>Verification code<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required maxlength="6"></label>`, 'Connect my account') + '<p class="muted">Already received a code? Enter the latest code above; you do not need to send another. A new email may create a website account. Verification codes and login tokens stay out of Cursor chat. Your account is connected only to this OS user’s local plugin.</p>';
  const server = createServer(async (req, res) => {
    // Native form POSTs need their real Origin for the strict check below.
    // same-origin suppresses referrers to other sites without turning this Origin into null.
    const send = (status, html) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); res.end(html); };
    const returnToLogin = () => { res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' }); res.end(); };
    try {
      if (req.headers.host !== new URL(base).host) return send(403, 'Forbidden host');
      const u = new URL(req.url, base), cookies = String(req.headers.cookie ?? '').split(';').map(s => s.trim());
      if (websiteConnection && req.method === 'GET' && u.pathname === '/account-callback') {
        const result = await websiteConnection.complete(u.searchParams, `${base}/account-callback`);
        if (result.cancelled) return send(200, shell('Connection cancelled', '<p>No account was connected. Return to Cursor when you want to connect.</p>'));
        // A callback starts at the merchant origin. Render success directly:
        // Strict cookies need not accompany a cross-site redirect chain.
        return send(200, shell('Account connected', `<p>账号已连接。请返回 Cursor 继续；连接本身没有下单或扣款。</p><p><a href="/?session=${nonce}">查看连接状态</a></p>`));
      }
      if (req.method === 'GET' && u.searchParams.get('session') === nonce) {
        res.writeHead(303, { Location: u.pathname + (u.searchParams.has('purchase') ? `?purchase=${encodeURIComponent(u.searchParams.get('purchase'))}&method=${encodeURIComponent(u.searchParams.get('method') ?? 'balance')}` : ''), 'Set-Cookie': `${cookieName}=${nonce}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      if (!cookies.includes(`${cookieName}=${nonce}`)) return send(403, shell('Open from Cursor', '<p>This page has no matching login session. Return to Cursor and ask it to connect your MZ MALL eSIM account, then open the new link it returns.</p>'));
      if (req.method === 'GET' && u.pathname === '/') {
        let connected = '';
        if (store.get('account', 'current')) {
          try { const a = await service.auth(); connected = `<p>Connected account: ${escape(a.email)} · Balance: ${a.balance} MMK.</p>` + form('/disconnect', '', 'Disconnect'); } catch { connected = '<p>Your session expired. Sign in again.</p>'; }
        }
        if (websiteConnection) return send(200, shell(connected ? 'Account connected' : 'Use your MZ MALL website account', connected + '<p>Sign-in and permission confirmation use the existing MZ MALL website. This local service only receives the protected callback.</p><p><a href="/website-login">Connect through the MZ MALL website</a></p>'));
        return send(200, shell('Connect your eSIM account', connected + (loginNotice ? `<p role="status">${escape(loginNotice)}</p>` : '') + loginForm(loginEmail)));
      }
      if (websiteConnection && req.method === 'GET' && u.pathname === '/website-login') {
        const url = await websiteConnection.begin(base);
        res.writeHead(303, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
      }
      if (websiteConnection && ['/send-code', '/login'].includes(u.pathname)) return send(410, shell('Use website sign-in', '<p>Return to Cursor and request a new account connection. Email and verification-code entry now use the existing MZ MALL website.</p>'));
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
        loginEmail = email;
        if (u.pathname === '/send-code') {
          const nextSend = sendCooldowns.get(email) ?? 0;
          if (nextSend > Date.now()) {
            loginNotice = `Please wait ${Math.ceil((nextSend - Date.now()) / 1000)} seconds before requesting a new code. If you already received a code, enter it below to connect your account.`;
            return returnToLogin();
          }
          // Reserve the interval before awaiting the API so double-clicks cannot
          // create concurrent sends. The upstream also limits failed sends.
          for (const [key, until] of sendCooldowns) if (until <= Date.now()) sendCooldowns.delete(key);
          sendCooldowns.set(email, Date.now() + 60000);
          try {
            await api.call('send_email_code', { email }, { write: true });
            loginNotice = 'Check your email, including spam, and enter the latest verification code below.';
          } catch (e) {
            loginNotice = `${e.message} If you already received a code, enter it below. Otherwise wait at least 60 seconds before requesting another; this message does not confirm email delivery.`;
          }
          // Refreshing the result must not repeat the email-send POST.
          return returnToLogin();
        }
        const code = String(body.get('code') ?? '');
        if (!/^[0-9]{6}$/.test(code)) {
          loginNotice = 'Enter the six-digit verification code from your latest email.';
          return returnToLogin();
        }
        try {
          const login = await api.call('login_email', { email, code }, { write: true });
          if (!login.token) throw new Error('Account connection failed');
          const verified = await api.call('user_info', {}, { token: login.token });
          store.put('account', 'current', { token: login.token, uid: verified.uid, expire_time: login.expire_time });
          loginNotice = '';
          return send(200, shell('Account connected', '<p>Return to Cursor. The plugin can now access your own eSIM account.</p>'));
        } catch (e) {
          loginNotice = e.message;
          return returnToLogin();
        }
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
  // Browsers share cookies across ports. Give each running portal its own
  // cookie name so another MCP instance or test portal cannot overwrite it.
  cookieName = `mz_esim_session_${server.address().port}`;
  return { server, base, accountUrl: () => websiteConnection ? websiteConnection.begin(base) : `${base}/?session=${nonce}`, approvalUrl: (id, method) => `${base}/approve?session=${nonce}&purchase=${encodeURIComponent(id)}&method=${method}` };
}
