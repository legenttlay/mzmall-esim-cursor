# Review evidence — version 0.2.2

This is a development pilot, not a marketplace-approved commerce listing. No real order, payment or eSIM issuance was performed during implementation. The merchant's existing customer login page was opened through the 0.2.0 connection link in the real in-app browser; the customer subsequently completed website sign-in and consent. A read-only merchant account check confirmed the saved identity; no real order or payment was made.

## Executed evidence

- `npm test`: **32 passed**, with synthetic accounts, order IDs and non-working LPA installation strings. Includes MCP tool discovery, explicit host elicitation, payment/fulfillment separation, QR generation, concurrent requests, reused upstream orders, declined approval, price changes, payment timeout/restart recovery, account isolation, closed orders, local portal CSRF/Host checks, credential filtering and the purchase-disable switch.
- `node scripts/bundle-smoke.mjs`: bundled Node runtime starts through the actual stdio transport, discovers ten tools, queries the real Thailand catalog (20 grouped products on page 1), and rejects creation while purchases are disabled. No credentials, real order or payment are needed.
- `npm run smoke:catalog`: real public catalog and product-detail reads. On 2026-10-13 the catalog contained 129 grouped Thailand results; a returned product was ID 2177, retail 2340 MMK. These are a dated observation, not a fixed test expectation or a current advertised price.
- Dependency install audit: zero reported vulnerabilities at installation. Node SQLite is experimental in the tested Node 24 runtime.

## 0.1.1 startup correction

The first version passed single-instance startup but failed under concurrent cold starts. Cursor's actual plugin log showed repeated connection attempts and a closed MCP connection at first startup. A 12-instance reproduction produced 11 startup failures. The correction atomically creates one complete vault key, preserves any existing key, and sets SQLite's busy timeout before journal/schema initialization. The new regression starts 12 real stdio MCP processes against the same new data directory and verifies all 12 discover ten tools. No user credentials or stored orders are replaced. Startup diagnostics now include safe error codes and Node version without raw exceptions.

## 0.1.2 private form correction

The in-app browser reproduced a native form POST with `Origin: null` under the login page's `Referrer-Policy: no-referrer`, returning `Forbidden origin` before any email API call. Form pages now use `same-origin`; the initial nonce redirect keeps `no-referrer`. Strict Host, Origin, session cookie and CSRF checks remain required. The real browser then completed both native forms against the isolated mock API with same-origin requests and HTTP 200. No production email, order or payment was created by this verification. `scripts/portal-browser-smoke.mjs` provides that isolated browser test; `scripts/account-portal.mjs` is an account-only helper for the local pilot.

## 0.1.3 code-send recovery

The portal keeps the email and OTP form visible when the website rejects a send or login request. Code-send results redirect to GET, so refreshing does not resend email. A per-email 60-second interval is reserved before the API call to suppress duplicate concurrent submissions; upstream rate limits remain active. A throttle response does not claim successful email delivery. SMTP failures are reduced to a safe customer message without returning server diagnostics. Automated tests verify retained login, no email resend on refresh, one API call under concurrent submissions and private OTP handling. In the real in-app browser, `scripts/portal-browser-smoke.mjs --throttled` showed the warning together with the OTP form, refreshed the GET result, and completed the mock account connection. No production email, order or payment was created by that test.

## 0.1.4 local session isolation

Browsers share cookies between services on the same hostname even when their ports differ. Two running local portals used the same cookie name, so opening another MCP instance or a test portal could invalidate the customer's active page. The regression reproduced that replacement. Each running portal now uses its own port in the cookie name while keeping session, Host, Origin and CSRF checks. The regression opens both portals with one browser-style cookie jar and verifies both remain available and reject each other's form token. The real in-app browser also opened a second isolated mock portal and refreshed the customer's local page; the original page remained available. No email or login was submitted by that browser verification. An expired-page message now tells the customer to request a fresh account connection from Cursor.

## 0.2.0 existing website login

Account connection now returns a merchant website link. The existing hotel-app customer login and return-to-webview route are reused, followed by explicit website connection consent. The callback uses a ten-minute state/verifier pair and a two-minute one-use grant bound to the exact loopback address and S256 challenge. The merchant issues a separate login only during successful exchange; raw login tokens never enter redirect URLs or chat. Tests cover replay, cancellation, unknown exchange, callback mismatch, duplicate parameters, identity mismatch and cookie-free callbacks. The callback renders success directly, so it does not depend on Strict cookies during a cross-site redirect chain. The local production sign-in page contains no email or OTP form. The PHP handoff has 23 test-only checks and the website session/callback helper has 17 checks. Production deployment preserves hashes of the H5 entry, its runtime and the original login asset. An anonymous live probe verifies the website page, JS MIME types, protected approval endpoint and cancellation without customer login, token issuance, order or payment. This is a website-to-local handoff, not the hosted OAuth/MCP service needed for public Grok Bot integration.

## Reviewer walkthrough draft

These natural-language host cases have **not been run in Cursor chat**. Tool-level automated tests are separate evidence. Use a dedicated customer account with representative test data. Do not send credentials in public repository files.

| Case | Prompt | Expected observable behavior | Host execution |
|---|---|---|---|
| Positive 1 | Find travel eSIMs for Thailand for seven days; show data limits and retail prices. | `search_esim_plans` with TH and validity_days=7; read the chosen plan; only returned plans/prices are described. | Not run |
| Positive 2 | Connect my account and show its balance. | `connect_esim_account`; user enters OTP privately; `get_esim_account` returns only the connected customer's identity/balance. | Not run |
| Positive 3 | Prepare one chosen eSIM for my email within my stated budget. | `prepare_esim_purchase` with exact product/quantity/email/budget and stable request ID; output explicitly remains unpaid. | Not run |
| Positive 4 | Show the payment quote, then pay from my balance after I approve. | `get_esim_payment_quote`, then `pay_esim_purchase`; fresh approval precedes payment; merchant status confirms payment. | Not run |
| Positive 5 | Check the same paid purchase and give me its installation QR. | `get_esim_purchase_status`, then `get_esim_delivery`; only paid valid installation credentials are returned; all ordered cards are required for full delivery. | Not run |
| Negative 1 | Top up this physical SIM ICCID. | Explain that physical SIM recharge is outside this connector; no purchase/payment tool. | Not run |
| Negative 2 | Refund my installed eSIM immediately. | Explain merchant-assisted refund eligibility; do not claim refund/cancellation and do not call a purchase tool. | Not run |
| Negative 3 | Purchase a hotel room instead. | Explain that this plugin supports digital eSIMs; no eSIM order or payment. | Not run |

Card variant: create a secure Stripe checkout, verify that its URL is not reported as paid, authorize the final amount securely, then retrieve merchant-confirmed delivery. Actual card authentication, webhook, live supplier issuance and paid after-sales handling remain unverified.

## Remaining public preparation

1. Source publisher confirmed as `legenttlay`; dedicated repository: https://github.com/legenttlay/mzmall-esim-cursor. Complete any business verification requested by Cursor and finalize the listing.
2. A live purchase pilot under the customer's explicitly approved price limit.
3. Published eSIM/plugin terms, refund support arrangement, and policy coverage for local token/journal storage.
4. A real Cursor walkthrough recording and any reviewer access requested by the current marketplace portal.
5. Enable the intended commerce behavior in the final release only after verification; the current release ships with purchasing disabled.

Cursor format is used. ChatGPT/OpenAI submission-specific schema fields and reviewer addresses are not applicable to this Cursor package.

## 0.2.1 return and conversation continuation

The connected callback and account-status page provide a prominent Return to Cursor button and a manual fallback prompt. Cursor’s documented prompt deeplink pre-fills a message for the customer to review and send; it does not guarantee the previous chat or execute a message automatically. No token, OTP, email or balance is placed in the deeplink. A connection can retain its shopping draft for 24 hours, accessible only after merchant identity verification for the same account. `get_esim_account(connection_id, wait_seconds=30)` briefly waits for that exact login so the agent can continue the original request. Tests verify callback wake-up, selection recovery without orders/payments, other-account rejection, cancelled/expired/interrupted results, and an expired token never showing a successful connection. The same ten tools remain. The automatic full Cursor chat experience and a real payment still require a customer walkthrough.

## 0.2.2 compact success dialog

Callback success and the connected landing page show a responsive, keyboard-accessible success dialog with one return action and a manual fallback. Account details and disconnect controls live at the separate cookie-protected `/account` page. Existing callback tests verify that the dialog omits email, balance, disconnect forms and tokens, while the management page retains its session guard and disconnect form. The same 32 tests remain. Native host-managed remote OAuth is still a future production integration; changing the dialog does not implement it.
