# MZ MALL eSIM for Cursor — development pilot

Buy travel eSIMs through the existing MZ MALL website APIs: search plans, sign in privately, create an unpaid order, approve a balance payment or secure card checkout, check payment, and retrieve paid installation QR codes. This is a **local Cursor plugin**, requiring Node.js 24+. It is not a hosted Grok Bot connector or an approved marketplace listing.

The release targets Cursor IDE. Node runs the connector on the customer's computer. The plugin does not ship supplier credentials, merchant payment secrets or shared customer tokens. It has no access to project files, shell execution tools or browser passwords. Version 0.2.0 reuses the existing MZ MALL customer website sign-in (email or supported social login) and its existing return route. A website confirmation page asks the customer to allow account connection. The loopback service receives a one-use, S256-bound callback; it no longer asks for email or OTP. Entering a new email on the website may register an account under that website's existing signup flow.

## Install and test

```powershell
npm ci
npm test
npm run build
npm run smoke:catalog
```

Copy the built `artifacts/public-repository` folder to `~/.cursor/plugins/local/mzmall-esim`, reload Cursor, and check the ten eSIM tools in Customize. Local plugin imports must be enabled by the host/team. The packaged runtime in `dist/index.mjs` includes npm dependencies; no install script runs for customers. Node 24 must be available on PATH.

Purchases default to disabled (`MZMALL_ENABLE_PURCHASES=0`). For an explicitly authorized pilot, change this to `1` in the local plugin's `mcp.json`, reload Cursor, connect **your own** account, and approve each purchase. Enabling purchase support does not approve any particular transaction.

Try:

- “Find an eSIM for Thailand for seven days. Show the data limit and price; don't buy yet.”
- “Connect my MZ MALL eSIM account.”
- “Prepare one of the selected eSIMs for my delivery email within my stated MMK budget. Show the full payment quote.”
- “Pay this specific order from my balance after I approve the details, then check delivery.”
- “Check the same purchase after a connection interruption. Don't charge again.”

## Payment and delivery

Customers can start by asking for an eSIM. The agent selects a suitable plan before login, preserves the selection with the website connection, and briefly waits for that exact connection using `get_esim_account(connection_id, wait_seconds=30)`. When it completes, the same conversation can continue with price confirmation. A manual **Return to Cursor** button uses Cursor's documented prompt deeplink and can restore the saved draft in another chat. The customer reviews and sends that prompt; it cannot automatically send a chat message, guarantee the original chat opens, or authorize a payment. No account tokens, OTPs or delivery email enter the deeplink. Saved selections are available for 24 hours only to the verified connected account.

Balance payments can finish in the agent conversation after explicit host elicitation, or a private browser approval if the host lacks elicitation. Card payments require Stripe's secure checkout and any bank authentication; the connector resumes with payment verification and QR delivery. **Inline card payment in Cursor chat has not been implemented or verified.** Card quotes include a CNY estimate; Stripe checkout displays the final amount before customer authorization. No card details enter a tool argument.

Only the merchant-confirmed `is_pay` result counts as paid. QR delivery requires paid status and valid installation codes for every ordered card. Payment, fulfillment, installation and network activation are separate states. Never automatically retry an unknown payment outcome. The journal persists attempts across process restarts.

Paid cancellations/refunds are not supported by this API connector. Merchant support determines refund eligibility. The existing unpaid-cancellation endpoint is deliberately not exposed because its initial-unpaid status and cancelled status overlap. No refund promises are made.

## Data and security

The default vault is `~/.mzmall-esim`, outside the plugin repository. It holds the connected account token, encrypted order journal, temporary connection verifier and one-use approvals. AES-GCM protects records; the key is held in the same OS-user directory. Protect that directory with OS permissions; encryption is not a defense against another process already running as the same OS user. No credentials are logged or returned to the agent. Do not share the vault, include it in a public ZIP, or configure a shared merchant/customer account. The local portal binds only to 127.0.0.1 and enforces session cookies, CSRF and Host/Origin checks on local forms. The website callback instead requires the matching state, verifier, expiry and exact callback URL; it needs no local browser cookie. The merchant exchanges its short-lived code for a separate login, so disconnecting the connector does not log out the existing website session.

This website-to-local handoff is **not a public MCP OAuth authorization server**. A hosted Grok Bot connector still needs its own remote transport, supported OAuth client integration and per-customer isolation. The original website login and frontend bundle are reused; they are not part of this public plugin repository.

## Public submission

Submit a dedicated **public plugin repository** at https://cursor.com/marketplace/publish after the live pilot and publisher review. Do not publish the hotel website repository. The build produces a separate public-repository copy and ZIP. The public plugin is MIT-licensed; all server source and tests are included.

The confirmed source publisher is `legenttlay`, and the dedicated repository is https://github.com/legenttlay/mzmall-esim-cursor. Any business/developer verification requested by Cursor, supported marketplace audience, approved purchase configuration, published eSIM terms/refund policy and a live demo remain preparation items. This development package is **not ready to submit as a fully verified commerce connector**.

Official references: [Cursor plugins](https://cursor.com/docs/reference/plugins), [Cursor MCP](https://cursor.com/docs/mcp), [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).
