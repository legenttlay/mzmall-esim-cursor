# Review evidence — version 0.1.1

This is a development pilot, not a marketplace-approved commerce listing. No real order, payment or eSIM issuance was performed during implementation.

## Executed evidence

- `npm test`: **19 passed**, with synthetic accounts, order IDs and non-working LPA installation strings. Includes MCP tool discovery, explicit host elicitation, payment/fulfillment separation, QR generation, concurrent requests, reused upstream orders, declined approval, price changes, payment timeout/restart recovery, account isolation, closed orders, local portal CSRF/Host checks, credential filtering and the purchase-disable switch.
- `node scripts/bundle-smoke.mjs`: bundled Node runtime starts through the actual stdio transport, discovers ten tools, queries the real Thailand catalog (20 grouped products on page 1), and rejects creation while purchases are disabled. No credentials, real order or payment are needed.
- `npm run smoke:catalog`: real public catalog and product-detail reads. On 2026-10-13 the catalog contained 129 grouped Thailand results; a returned product was ID 2177, retail 2340 MMK. These are a dated observation, not a fixed test expectation or a current advertised price.
- Dependency install audit: zero reported vulnerabilities at installation. Node SQLite is experimental in the tested Node 24 runtime.

## 0.1.1 startup correction

The first version passed single-instance startup but failed under concurrent cold starts. Cursor's actual plugin log showed repeated connection attempts and a closed MCP connection at first startup. A 12-instance reproduction produced 11 startup failures. The correction atomically creates one complete vault key, preserves any existing key, and sets SQLite's busy timeout before journal/schema initialization. The new regression starts 12 real stdio MCP processes against the same new data directory and verifies all 12 discover ten tools. No user credentials or stored orders are replaced. Startup diagnostics now include safe error codes and Node version without raw exceptions.

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
