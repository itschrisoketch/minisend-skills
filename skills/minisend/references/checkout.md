# Checkout

## What it does

Checkout takes a payment from a customer and settles it as local currency to the bank or mobile money account configured on your Minisend account. You name a price in USDC; the customer pays — with a stablecoin, or with M-Pesa in Kenya; Minisend converts and pays out to your configured payout account in KES, NGN, GHS, or UGX.

The paying party is the **customer**. There is no recipient in checkout: the payout destination is a property of your account, not something you set per session. (Off-ramp is the product where you name a recipient per order — see `references/offramp.md`.)

Base URL: `https://merchant.minisend.xyz`

## Two ways to use it

**API-created sessions.** You call `POST /api/merchant/checkout` with the amount, get back a `session_id` and a `checkout_url`, and send the customer to that URL. Use this when the price comes from your own system — a cart total, an invoice, a subscription charge — and when you need `external_id` on the session so the webhook can be reconciled against your own records. This is the only checkout endpoint that takes an API key.

**Hosted payment links.** Every account has a slug and a permanent link at `https://merchant.minisend.xyz/pay/{slug}`. The customer opens it, types an amount, and pays. Nothing is created until they do. Use this when you have no backend to integrate — a bio link, an invoice footer, a QR code on a counter. The endpoints behind that page are **public**, and you can drive them yourself from a browser if you want your own payment page.

The two converge: both end at the same hosted checkout page, both produce the same session object, and both fire the same webhooks.

## Requirements

For `POST /api/merchant/checkout` only:

- An `ms_live_` API key carrying the `checkout` scope.
- The checkout capability enabled on your account.

**Checkout is opt-out.** Unlike off-ramp and on-ramp, the capability is enabled by default on every account — the gate exists so Minisend can switch checkout off for a specific account, not to hold you back from a product you already have. `checkout` is also the default scope: a key created from the dashboard carries it, and a key with no scope list recorded at all resolves to `checkout`-only. An *explicitly empty* scope list is different — it grants nothing, and is how access is revoked without deleting the key.

Both gates fail with the identical 403. You cannot tell which one is missing, and you must not build logic that tries:

```json
{ "error": "Your account doesn't have checkout access yet. Please contact info@minisend.xyz to request access." }
```

Read `references/authentication.md` before writing request code.

Every other endpoint in this file is public and takes no key at all.

**Rate limits.** Session creation over the API carries a per-account cap of 30 per minute, on top of the general 60-requests-per-60-seconds limit that applies per calling client (keyed by IP, not by key). **The two 429s carry different bodies**, and a third — the public endpoints' — is different again. Match on the status code, not the text:

```json
{ "error": "Too many checkout sessions created recently. Please slow down, or contact info@minisend.xyz if you need a higher limit." }
```

```json
{ "error": "Rate limit exceeded" }
```

The first is the per-account creation cap; the second is the general limit. **Both fire before the request body is read** — so a malformed body still costs you one of your thirty creates per minute. What separates them is auth, not ordering: the general limit is checked before the `Authorization` header is even looked at, so a request with a bad key or no key still counts against it, while the creation cap is per account and therefore only reachable once the key has authenticated.

The public endpoints each carry their own per-IP limit, listed with each endpoint below. All of them return `429 { "error": "Too many requests" }`. `X-RateLimit-Remaining` appears on some of those 429s and never on a success, so you cannot read it ahead of time to throttle preemptively — and you cannot rely on it being there at all. Track your own request rate client-side instead.

## Public versus key-required

The single most common way to get this integration wrong is to guess. Only one endpoint here authenticates:

| Endpoint | Auth | Called from |
| --- | --- | --- |
| `POST /api/merchant/checkout` | **`ms_live_` key, `checkout` scope** | Your server only |
| `GET /api/merchant/checkout/{session_id}` | Public | Browser or server |
| `GET /api/merchant/checkout/{session_id}/mpesa` | Public | Browser or server |
| `POST /api/merchant/checkout/{session_id}/mpesa` | Public | Browser or server |
| `GET /api/merchant/pay/info?slug=` | Public | Browser or server |
| `POST /api/merchant/pay` | Public | Browser or server |
| `POST /api/merchant/pay/mpesa` | Public | Browser or server |

Consequences worth internalising:

- **Do not proxy the public endpoints through your backend to attach a key.** Sending an `Authorization` header to them does nothing; they never look at it. A server-side proxy in front of `GET /api/merchant/checkout/{session_id}` is pure latency.
- **Do not call `POST /api/merchant/checkout` from a browser.** It needs an `ms_live_` key, which must never reach client code. Create the session server-side and send the browser the `checkout_url` or the `session_id`.
- **`POST /api/merchant/pay` creates a real session with no key.** Anyone who knows a slug can create one, capped only by the per-IP limit. That is the design — a payment link is public by definition — but do not treat "a session exists" as evidence that you created it. Reconcile on the webhook and on `external_id`, which only the authenticated create path can set.

## Endpoint reference

> **About the numbers in the sample responses below.** Every priced field — `rate`, `indicative_rate`, `mpesa_rate`, `platform_fee_rate`, `exchange_rate`, `gross_kes`, `net_kes`, `fee_kes`, `amount_local`, and `amount_usdc` on `POST /api/merchant/pay` — is shown as `0`. That is a placeholder, not a value, and this applies to the webhook payload later in the file too. Read the real figures from the live response; never hardcode one and never derive one from another.

All requests use `Content-Type: application/json`.

### `POST /api/merchant/checkout`

**Requires an `ms_live_` key with the `checkout` scope.** Creates a session and returns the hosted checkout URL.

Request:

```json
{
  "amount": 25,
  "description": "Order #1183",
  "external_id": "order_1183",
  "customer_email": "customer@example.com",
  "redirect_url": "https://yourstore.com/orders/1183/thanks"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `amount` | yes | USDC. Positive finite number, rounded to 2 decimal places. This is the amount the customer sends — no gross-up is applied on this path. |
| `description` | no | Shown to the customer on the hosted page. |
| `external_id` | no | Your own identifier. Echoed back on the webhook as `external_id`. The only reliable join key back to your own records — set it. |
| `customer_email` | no | Recorded on the session. Not returned by the public status endpoint. |
| `settlement_mode` | no | `fiat` or `usdc`. Defaults to the account's configured mode. `fiat` pays out local currency; `usdc` keeps the proceeds in USDC. |
| `settlement_chain` | no | One of `BASE`, `ARB`, `AVAX`, `OP`, `ETH`, `MATIC`. Defaults to the account's configured chain. Only meaningful when the session settles in USDC — see the wart below. |
| `redirect_url` | no | Where the customer is sent once the payment is done. Absolute `https` URL, at most 2048 characters, no embedded username or password. `return_url` and `success_url` are accepted as aliases. See [Sending the customer back](#sending-the-customer-back-to-your-site). |

Response `201`:

```json
{
  "session_id": "3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "checkout_url": "https://merchant.minisend.xyz/checkout/3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "deposit_address": "0x1234567890abcdef1234567890abcdef12345678",
  "amount_usdc": 25,
  "expires_at": "2026-07-31T11:00:00.000Z",
  "status": "pending",
  "settlement_mode": "usdc",
  "settlement_chain": "ARB",
  "redirect_url": "https://yourstore.com/orders/1183/thanks"
}
```

- `checkout_url` is the hosted page. Redirecting the customer there is the shortest correct integration — it handles the wallet flow, the QR code, the M-Pesa option, and the live status.
- `deposit_address` is the on-chain destination for the session. **It is stable across every session on your account** and is not minted per session, so two open sessions share it and are told apart by amount. Do not use it as a session identifier, and do not assume a payment to it belongs to any particular session.
- **The same address works on every chain the account accepts.** It is derived so that it is identical across supported EVM chains, which is why the hosted page can advertise one address for all of them. You do not get a different address per chain and should not look for one.
- `expires_at` is 30 minutes from creation.
- `status` is always `pending` here.
- `description`, `external_id`, and `customer_email` are **not** echoed back. Keep your own copy.
- `redirect_url` **is** echoed back, and only when one was stored — the key is absent otherwise. It is read back off the saved session rather than off your request, so its presence is confirmation the value was actually recorded.
- `settlement_mode` and `settlement_chain` are echoed back, resolved — you see the account default when you sent nothing.

**`settlement_chain` is echoed on fiat sessions too, and means nothing there.** Nothing is forwarded when the session settles in local currency. `settlement_mode` in the same response is the only thing that tells you whether the chain is live or inert, so branch on the mode, never on the presence of a chain.

Errors:

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "error": "Invalid amount. Must be a positive number (USDC)." }` | Missing, non-numeric, non-finite, or non-positive `amount`. |
| `400` | `{ "error": "Amount exceeds maximum of $50,000 USDC per checkout." }` | Above the per-session ceiling. The figure in the message is the configured ceiling — read it from the message rather than hardcoding it. |
| `400` | `{ "error": "Invalid settlement_mode. Must be 'fiat' or 'usdc'." }` | `settlement_mode` was present but not one of the two. |
| `400` | `{ "error": "Invalid settlement_chain. Must be one of BASE, ARB, AVAX, OP, ETH, MATIC." }` | `settlement_chain` was present but not one of the six, including a correct name in the wrong case. |
| `400` | `{ "error": "redirect_url must use https (http is allowed only for localhost)." }` | Plain `http` on any host other than `localhost` or `127.0.0.1`, or a scheme that is not http or https at all. |
| `400` | `{ "error": "redirect_url must be an absolute URL, e.g. https://example.com/thanks." }` | A relative path, or anything that does not parse as a URL. |
| `400` | `{ "error": "redirect_url must not contain a username or password." }` | Credentials embedded in the URL. |
| `400` | `{ "error": "redirect_url must be at most 2048 characters." }` | Over the length cap. |
| `502` | Provisioning failure on the destination chain. | **Nothing was created.** A USDC session on a chain the account has not used before provisions a destination wallet during the create call, and this is that step failing. Deliberately surfaced here rather than letting the session succeed and quietly fail to forward later. Retry. |
| `401` / `403` | See `references/authentication.md`. | Key missing, invalid, or not permitted. |
| `429` | Creation cap or general limit. | See [Requirements](#requirements). |
| `500` | `{ "error": "Merchant has no deposit address. Please re-register." }` | The account has no deposit address provisioned. |
| `500` | `{ "error": "Failed to create checkout session" }` | Nothing created. **This endpoint also returns this `500` for an unparseable request body** — unlike off-ramp, on-ramp, and the wallet API, which return `400` for malformed JSON. Check that you sent valid JSON with `Content-Type: application/json` before reading it as a Minisend fault. See `references/errors.md`. |

Note the ordering: auth, then the per-account creation cap, then the body checks. A malformed `amount` still costs you one of your thirty creates per minute.

### `GET /api/merchant/checkout/{session_id}`

**Public.** The status endpoint. Limit: 120 requests per 60 seconds per IP.

Response `200`:

```json
{
  "session_id": "3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "status": "pending",
  "amount_usdc": 25,
  "description": "Order #1183",
  "deposit_address": "0x1234567890abcdef1234567890abcdef12345678",
  "expires_at": "2026-07-31T11:00:00.000Z",
  "created_at": "2026-07-31T10:30:00.000Z",
  "payment_method": "crypto",
  "awaiting_onramp": false,
  "redirect_url": "https://yourstore.com/thanks?order=1183&session_id=3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410&status=pending",
  "settlement_chain": "ARB",
  "forward": { "status": "not_started", "chain": "ARB" },
  "merchant": {
    "business_name": "Example Traders",
    "logo_url": "https://example.com/logo.png",
    "accepted_chains": ["BASE", "ETH", "ARB", "OP", "MATIC", "AVAX"]
  }
}
```

| Field | Notes |
| --- | --- |
| `status` | One of the lifecycle strings — see [Session lifecycle](#session-lifecycle). |
| `description` | Whatever was set at creation, or `null`. |
| `payment_method` | `crypto` or `mpesa`. **Defaults to `crypto`** — it is never `null`, and it stays `crypto` until an M-Pesa payment is actually started on the session. |
| `redirect_url` | The fully built return URL, with `session_id` and `status` already appended, or `null` when the session was created without one. The `status` inside it always matches the `status` field above, so it is safe to read either. |
| `awaiting_onramp` | `true` only while an M-Pesa prompt is in flight on a still-`pending` session. This is the "check your phone" signal. It goes back to `false` if the prompt fails and the session reverts to being payable in stablecoin. |
| `merchant` | Display info for rendering your own page, or `null` if the account record could not be loaded. `accepted_chains` is the set of chain codes this account accepts stablecoin deposits on — see [What the customer can pay with](#what-the-customer-can-pay-with). An empty array or a `null` here means the account predates the setting; read it as "all supported chains", not "none". |
| `settlement_chain` | Where the proceeds end up. **USDC-settling sessions only.** |
| `forward` | The state of the move to that chain. **USDC-settling sessions only.** See below. |

#### `forward` — where the money actually is

On a session settling in USDC, `forward` reports the move from Base to the destination chain.

```json
{ "status": "completed", "chain": "ARB", "tx_hash": "0xabc…" }
```

| `status` | Meaning |
| --- | --- |
| `not_required` | The destination is Base. Nothing has to move; the money is already there. |
| `not_started` | The session has not been paid yet. |
| `pending` | The move is in flight. Also returned when the state is momentarily unreadable, so treat it as "not yet", not as a guarantee of progress. |
| `completed` | Done. `tx_hash` is the transaction on the destination chain. |
| `failed` | It will not arrive without intervention. **The funds are safe on Base**, so this is a delivery failure and not a loss. Do not surface it to a customer as a payment problem; the customer's payment succeeded. Contact Minisend. |

`tx_hash` is present only on `completed`.

**`checkout.completed` fires before any of this is attempted.** That is deliberate — forwarding must never delay a payment confirmation — but it means a `completed` session does **not** mean the money has reached Arbitrum. If your fulfilment depends on funds being on the destination chain rather than on the payment having succeeded, gate it on `forward.status === "completed"`, not on the session status.

**A failed forward does emit a webhook: `settlement.forward_failed`.** It is announced by a periodic reconciliation pass rather than at the moment of failure, so it arrives late relative to the failure itself, and it is announced once per session. `forward.status` on this endpoint remains the authoritative live view, and reading it is still the fastest way to know — but you are no longer blind if you only consume webhooks. See `references/webhooks.md`.

**Two field groups only appear conditionally**, and are genuinely absent from the JSON otherwise:

- When `payment_method` is `mpesa`: `amount_local` (the local-currency figure quoted for the M-Pesa payment).
- When `status` is `completed`: `amount_local`, `exchange_rate`, `settlement_receipt`, `completed_at`.

**Everything else follows the null convention**: the key is always present and carries `null` when unset, because the row values are passed through uncoalesced. So there are two different checks to write against one response — `'settlement_receipt' in session` for the conditional group, and `session.description !== null` for the rest. A single helper that assumes one behaviour will misread the other. (This is a checkout-specific wrinkle; the off-ramp and on-ramp order objects have no conditional group at all.)

**This endpoint is not a pure read — it can change the session.** Two side effects:

- **A `pending` session whose `expires_at` has passed is flipped to `expired`** and returned as such. There is no expiry webhook to lose by doing this (see [Webhook events](#webhook-events)), but the transition is real and irreversible for a stablecoin payment.
- **A session stuck on `settling` for more than about two minutes triggers a settlement re-check**, which can drive it to `completed` or `failed` on the spot — and deliver `checkout.completed` inline, from within your read. So a poll can be what produces the webhook, and the webhook can arrive while the polling request is still open. Do not assume the two orderings, and do not assume a webhook implies you were not the one who caused it.

Neither side effect is something to avoid — the recovery one is useful — but they mean you cannot treat this endpoint as free of consequences, and a health check that polls every session on a loop is not harmless.

Errors: `404 { "error": "Checkout session not found" }`; `429 { "error": "Too many requests" }`; `500 { "error": "Failed to fetch checkout session" }`.

### `GET /api/merchant/checkout/{session_id}/mpesa`

**Public.** Prices the session in KES so you can show the customer what their phone will be charged. Nothing is created and no prompt is sent. Limit: 60 requests per 60 seconds per IP.

Response `200`:

```json
{
  "eligible": true,
  "gross_kes": 0,
  "net_kes": 0,
  "fee_kes": 0,
  "rate": 0
}
```

- **`gross_kes` is what the customer's phone will be prompted for.** Show them this figure. It is `net_kes` plus `fee_kes`.
- **`eligible` is a `200`, not an error.** A session whose amount falls outside the M-Pesa band comes back `eligible: false` with the figures still populated — check the flag before offering the M-Pesa option rather than assuming a `200` means "go".

Errors: `404 { "error": "Checkout session not found" }`; `410 { "error": "Session is not payable" }` if the session is no longer `pending`; `410 { "error": "Session expired" }`; `429`; `500 { "error": "Failed to quote" }`.

### `POST /api/merchant/checkout/{session_id}/mpesa`

**Public.** Sends the M-Pesa payment prompt to the customer's phone for an existing session. A `200` here means a real phone is ringing. Limit: 10 requests per 60 seconds per IP.

Request:

```json
{ "phone": "+254712345678", "network": "Safaricom" }
```

| Field | Required | Notes |
| --- | --- | --- |
| `phone` | yes | The **paying customer's** Kenyan mobile number. Accepted input shapes are documented in `references/recipients.md`. Normalised to `0XXXXXXXXX`. |
| `network` | no | `Safaricom` or `Airtel`, overriding auto-detection. Leave it out — auto-detection from the number's prefix is the better path. |

The amount is **not** a request field. It is re-quoted server-side from the session; a client-supplied price is never trusted.

Response `200`:

```json
{ "success": true, "gross_kes": 0, "network": "Safaricom", "phone": "0712345678" }
```

The session stays `pending` and `awaiting_onramp` becomes `true`. Poll the status endpoint (or wait for the webhook) from there.

Errors:

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "error": "Missing phone number" }` | No `phone`. |
| `400` | Phone validation messages — see `references/recipients.md`. | Not a usable Kenyan mobile number. |
| `400` | `{ "error": "Amount is outside M-Pesa limits" }` | The session amount does not price into the permitted KES band. |
| `404` | `{ "error": "Checkout session not found" }` / `{ "error": "Merchant not found" }` | Unknown session, or the account behind it could not be loaded. |
| `500` | `{ "error": "Merchant wallet unavailable" }` | The account has no deposit address provisioned, so there is nowhere to release to. Nothing was charged. |
| `409` | `{ "error": "A payment request is already on its way to your phone. Wait a moment before retrying." }` | A prompt was already sent on this session within the last 90 seconds. |
| `410` | `{ "error": "Session is not payable" }` / `{ "error": "Session expired" }` | Session is no longer `pending`, or past `expires_at`. |
| `429` | `{ "error": "Too many requests" }` | Per-IP limit. |
| `502` | `{ "error": "Payment provider returned no transaction code" }` or a passed-through failure message. | The prompt could not be sent. Nothing was charged. |

**The 90-second cooldown is a double-charge guard, not a throttle.** One live prompt per session at a time: a second prompt could charge the customer twice, so the endpoint refuses until the window passes. Do not build a retry loop that hammers through it — surface the message and let the customer act.

## Payment links

Every account gets a slug, generated from the business name when the account is created and visible in the dashboard. The link is:

```
https://merchant.minisend.xyz/pay/{slug}
```

Sending a customer to that URL is the whole integration — the hosted page reads the account's display info, takes an amount, and creates the session. The three endpoints below are what that page calls, and they are public, so you can build your own page on top of them instead.

### `GET /api/merchant/pay/info?slug={slug}`

**Public.** Display info and indicative pricing for a slug. Limit: 60 requests per 60 seconds per IP.

Response `200`:

```json
{
  "business_name": "Example Traders",
  "logo_url": "https://example.com/logo.png",
  "tagline": "Fast local settlement",
  "slug": "example-traders",
  "payout_currency": "KES",
  "payout_method": "MOBILE",
  "indicative_rate": 0,
  "platform_fee_rate": 0,
  "mpesa_rate": 0
}
```

| Field | Notes |
| --- | --- |
| `payout_currency` | `KES`, `GHS`, `NGN`, or `UGX`. |
| `payout_method` | `MOBILE`, `BUY_GOODS`, `PAYBILL`, or `BANK_TRANSFER`. |
| `indicative_rate` | 1 USDC in the payout currency. **Indicative only** — for previewing an amount as the customer types. `null` if pricing is momentarily unavailable; render the currency without a figure rather than failing. |
| `platform_fee_rate` | Fractional rate applied on this account's payout currency. |
| `mpesa_rate` | The rate for the M-Pesa pay-in direction. `null` hides the M-Pesa option. **Any account can accept an M-Pesa payment regardless of its payout currency** — the two are independent. |

`logo_url` and `tagline` are `null` when unset. `indicative_rate` and `mpesa_rate` are fetched best-effort and independently: one can be `null` while the other is a number.

Errors: `400 { "error": "Missing slug" }`; `404 { "error": "Merchant not found" }` — returned both for an unknown slug and for an inactive account, with no way to distinguish them; `429`; `500 { "error": "Failed to fetch merchant info" }`.

### `POST /api/merchant/pay`

**Public.** Creates a checkout session from a slug. Limit: 20 requests per 60 seconds per IP.

Request:

```json
{ "slug": "example-traders", "amount": 25, "description": "Table 4" }
```

| Field | Required | Notes |
| --- | --- | --- |
| `slug` | yes | The account's slug. |
| `amount` | yes | **The net the business should receive**, in USDC. Must be greater than 0 and at most 10,000. Note this is a different, lower ceiling than the API create path's. |
| `description` | no | Shown on the hosted page. |

Response `201`:

```json
{
  "session_id": "3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "checkout_url": "https://merchant.minisend.xyz/checkout/3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "deposit_address": "0x1234567890abcdef1234567890abcdef12345678",
  "amount_usdc": 0,
  "merchant_amount_usdc": 25,
  "expires_at": "2026-07-31T11:00:00.000Z"
}
```

**`amount_usdc` is a `0` placeholder here**, like the priced fields elsewhere in this file — it is derived from the `amount` you sent, so printing a real pair would let you back out a rate. Read it from the live response.

**`amount_usdc` and `merchant_amount_usdc` are not the same number and you must not assume they are.** You send the net; the customer pays the grossed-up total so the business nets what you asked for. `amount_usdc` is that total — **the figure to quote the customer and the figure the payment must match**. `merchant_amount_usdc` echoes the net you sent. How far apart they sit depends on the account's payout currency, and for some payout currencies they coincide — which is exactly why you must read `amount_usdc` back every time instead of computing it or assuming either relationship.

This path takes **no `external_id` and no `customer_email`**, and returns no `status` field (the session is `pending`). If you need a join key back to your own records, use the authenticated create endpoint instead.

Errors: `400 { "error": "Missing merchant slug" }`; `400 { "error": "Amount must be between $0.01 and $10,000 USDC" }`; `404 { "error": "Merchant not found" }`; `429`; `500 { "error": "Merchant has no deposit address. Please contact support." }`; `500 { "error": "Failed to create payment session" }`.

### `POST /api/merchant/pay/mpesa`

**Public.** One shot: creates the session **and** sends the M-Pesa prompt in a single call, so the customer never sees a USDC figure. Limit: 10 requests per 60 seconds per IP.

Request:

```json
{
  "slug": "example-traders",
  "amount_kes": 3000,
  "phone": "+254712345678",
  "network": "Safaricom",
  "description": "Table 4"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `slug` | yes | The account's slug. |
| `amount_kes` | yes | **The exact KES the customer will be charged.** Rounded to a whole number. The fee is carved out of it; the remainder converts. This is the opposite direction from `POST /api/merchant/pay`, which fixes the net instead. |
| `phone` | yes | The paying customer's Kenyan mobile number. |
| `network` | no | `Safaricom` or `Airtel`, overriding auto-detection. |
| `description` | no | Shown on the hosted page. |

Response `201`:

```json
{
  "session_id": "3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "checkout_url": "https://merchant.minisend.xyz/checkout/3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "gross_kes": 0,
  "network": "Safaricom",
  "phone": "0712345678"
}
```

`gross_kes` equals the `amount_kes` you sent, after rounding. Route the customer to `checkout_url` to watch the prompt resolve.

Errors: `400 { "error": "Missing merchant slug" }`; `400 { "error": "Enter a valid amount" }`; `400 { "error": "Missing phone number" }`; `400` phone-validation messages; `400 { "error": "Amount must be between KES 20 and KES 250,000" }` (which also fires when the amount is technically in range but too small once the fee is taken out); `404 { "error": "Merchant not found" }`; `429`; `500 { "error": "Merchant wallet unavailable" }` if the account has no deposit address provisioned; `502` if the prompt could not be sent; `500 { "error": "Failed to start payment" }`.

**A `502` here leaves a real session behind.** The session was created before the prompt was attempted; it stays a plain `pending` session, payable in stablecoin, and expires on its own if nobody pays it. The response carries no `session_id`, so you have no handle on it. Retry by calling the endpoint again — you will get a new session.

## What the customer can pay with

Four routes, and they are not interchangeable in how they arrive.

**USDC on Base.** The native path. `deposit_address` is a Base address and this is the fastest, cheapest route. The hosted page's QR code prefills the exact amount for this combination.

**USDC on the other supported chains.** The chain codes the account accepts are returned as `accepted_chains` on the public status endpoint, drawn from `BASE`, `ETH`, `ARB`, `OP`, `MATIC`, and `AVAX`. **`BASE` is always in the set** — it cannot be switched off. The rest are per-account settings adjusted in the dashboard, so read `accepted_chains` from the session rather than hardcoding six chains. `deposit_address` is the same string on all of them.

**Base is the only instruction that is always safe.** Sending a customer to a non-Base chain has two possible bad outcomes, and neither is visible in the API:

- If the account does not accept that chain, the session is moved to `failed` — with no `checkout.failed` webhook (see [Webhook events](#webhook-events)), no automatic return, and resolution as a support matter.
- If cross-chain sweeping is not switched on for the deployment, a non-Base deposit parks at `deposit_received` and simply never settles. `accepted_chains` is returned to you either way, so it does **not** tell you whether a non-Base deposit will actually complete.

Treat `accepted_chains` as "chains that will not be outright rejected", not "chains that are guaranteed to settle". If a non-Base deposit sits at `deposit_received` past the point you would expect settlement, that is the signal — raise it with Minisend rather than waiting. Base always settles.

**USDT, and USDC from a wider chain set.** The hosted checkout and payment-link pages also accept USDT, and offer a broader list of chains than the six above, by normalising the inflow to USDC on Base before it is matched to the session. `accepted_chains` does not gate this path and there is no per-chain API signal for it — so if you are building your own payment page rather than using the hosted one, drive customers to the hosted page for anything other than the chains in `accepted_chains`.

**M-Pesa in Kenya**, via the two M-Pesa endpoints above. Kenya only, KES only, `Safaricom` and `Airtel` only.

### Quote the exact amount — and why an inexact one is worse than a rejection

Whatever the route, **quote the customer exactly the `amount_usdc` the create response gave you.** Deposits are matched to a session by destination address and amount, with about a cent of rounding slack.

What happens when the amount does *not* match depends on how many sessions are open on the address, and it catches integrators out either way. **The payment is not rejected.**

**Exactly one session open.** The deposit is attributed to it and settled for the amount actually received — the alternative would strand the customer's funds. So:

- **An underpaying customer still drives the session to `completed`.** There is no partial-payment state. `completed` means "a payment was attributed and settled", not "the expected amount arrived".
- **The webhook tells you.** `amount_usdc` remains the *expected* figure, but the payload also carries `amount_received_usdc` (what actually arrived) and `amount_matched` (`false` when it fell outside the tolerance). Reconcile on `amount_received_usdc`.

**Two or more sessions open.** The deposit is *not* attributed to any of them. There is no way to tell which session an off-amount payment was meant for, so guessing would complete the wrong order. The payment is held for manual review by Minisend, and:

- **No session changes status and no webhook fires.** The sessions stay `pending` until they expire.
- **You will not see this in any response.** Contact Minisend with the transaction hash to have the payment attributed.

So **do not reconcile on `amount_usdc`** — booking it as revenue on `checkout.completed` books money that may never have arrived. Reconcile on `amount_received_usdc`, treat `amount_matched: false` as needing review, and keep the number of simultaneously open sessions per account low so an off-amount payment resolves automatically instead of parking.

## Sending the customer back to your site

Set `redirect_url` when you create the session and the hosted page hands the customer back to you once the payment is done. Without it they finish on the Minisend page and stop there, which is fine for a payment link on a counter and wrong for a store that has its own order confirmation to show.

**Only the authenticated create path can set one.** `POST /api/merchant/pay` — the payment-link path — has no such field, so a link-driven session always ends on the hosted page.

### What the customer's browser lands on

Two parameters are appended to whatever you supplied, and the rest of your query string is left exactly as you wrote it:

| Parameter | Value |
| --- | --- |
| `session_id` | The session this return came from. |
| `status` | `completed`, `failed`, or `expired`. |

So `https://yourstore.com/thanks?order=1183` becomes:

```
https://yourstore.com/thanks?order=1183&session_id=3f9c2a71-...&status=completed
```

If you already put a `session_id` or a `status` of your own in the URL, **yours is kept and nothing is appended over it.** Pick different parameter names if you want both.

### When it fires

- **`completed`** — the customer is sent automatically, a few seconds after the success screen appears. Reaching for the receipt on that screen cancels the automatic return; a button to go back stays available either way.
- **`failed` and `expired`** — the link back is shown but never taken automatically. The customer may still want to retry or read what happened, and moving them off the page mid-thought is worse than letting them choose.

Because the automatic return only happens on `completed`, and `completed` is the same state that emits `checkout.completed`, the customer's return and your webhook cannot disagree about whether the payment settled.

### `status=completed` is not proof of payment

It is a query parameter. Anyone can type it into a browser, and a customer who abandons the payment can still arrive at your confirmation page by editing the URL.

Render the page off it if you like — that is what it is for — but **fulfilment belongs to the webhook, or to a server-side `GET /api/merchant/checkout/{session_id}` before you release anything.** Treating the parameter as authoritative is the one way this feature can cost you money.

## Session lifecycle

The complete status vocabulary. These exact strings appear on the status endpoint and on the webhook payload.

| Status | Meaning | Final? |
| --- | --- | --- |
| `pending` | Session created, waiting for payment. | no |
| `deposit_received` | The payment was detected. Payout has not started yet. | no |
| `settling` | The payout to the configured account is in flight. | no |
| `completed` | The payment came through. `completed_at` is set and `settlement_receipt` normally carries a reference. | **yes** |
| `failed` | The payout could not be completed. | in practice |
| `expired` | The window closed with nothing paid. | see below |

`pending` → `deposit_received` → `settling` → `completed` or `failed` is the stablecoin path. An M-Pesa-paid session skips the middle two entirely: it goes straight from `pending` to `completed` when the collection confirms, or stays `pending` if the prompt fails.

**`completed` is terminal and is the status to trust.** The deposit-matching, expiry, and settlement paths all refuse to touch a session that has reached it.

**`expired` is not final for an M-Pesa session.** If the customer's payment confirms after the window closed, the session still moves to `expired` → `completed` and `checkout.completed` fires — deliberately, because the customer was charged. For a stablecoin payment `expired` is terminal: an expired session is no longer matchable and a later deposit will not revive it.

**`failed` should be treated as terminal for your own flow control**, but make your handling idempotent rather than sealed: handle a `checkout.completed` for a session you already recorded as ended.

A failed M-Pesa prompt does **not** move the session to `failed`. It reverts the session to a plain `pending` stablecoin-payable session — `awaiting_onramp` goes back to `false` and `payment_method` back to `crypto` — so the customer can retry M-Pesa or pay with a stablecoin instead. Do not read a still-`pending` session as "the prompt is still live."

## Webhook events

Checkout emits **two** events to the webhook URL configured on your account:

| Event | Fires when |
| --- | --- |
| `checkout.completed` | The session reached `completed`. |
| `checkout.failed` | The payout was reported as failed by the settlement provider. |

**`checkout.failed` now covers every way a session reaches `failed`.** Earlier versions delivered it only from the payout leg, leaving five paths silent — a deposit on a chain the account does not accept, a payout that could not be initiated, a failed cross-chain sweep, a failure on the payout-confirmation path, and the settlement re-check that `GET /api/merchant/checkout/{session_id}` performs on a stuck session. All five deliver now.

Reconciling your own non-terminal sessions is still worth doing as a backstop — a webhook can always fail to reach you, and delivery is retried but not guaranteed — but the absence of `checkout.failed` is no longer expected to hide a failure.

**`checkout.expired` is delivered.** It fires when a session's window passes with no deposit, from whichever comes first: the periodic sweep, or a read of `GET /api/merchant/checkout/{session_id}` past `expires_at`, which expires the session in-band. Exactly one of the two delivers, so you will not see a duplicate. Earlier versions declared the event but never emitted it; if you built expiry detection from `expires_at` because of that, it still works and is a reasonable backstop.

Payload:

```json
{
  "event": "checkout.completed",
  "session_id": "3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
  "external_id": "order_1183",
  "payment_method": "crypto",
  "amount_usdc": 25,
  "amount_expected_usdc": 25,
  "amount_received_usdc": 25,
  "amount_matched": true,
  "amount_local": 0,
  "currency": "KES",
  "exchange_rate": 0,
  "receipt": "SLJ7K2P9QX",
  "status": "completed",
  "completed_at": "2026-07-31T10:32:41.000Z",
  "created_at": "2026-07-31T10:30:00.000Z"
}
```

- `amount_usdc` is what the session asked for. `amount_expected_usdc` is the same value under an unambiguous name; `amount_received_usdc` is what actually arrived on-chain, and `amount_matched` is `false` when the two differ by more than the tolerance. **Reconcile on `amount_received_usdc`.** Both received-amount fields are omitted when no deposit was attributed — on `checkout.expired`, always.
- `external_id` is the value you set at creation — present only on sessions created through the authenticated endpoint.
- `currency` is the account's payout currency, **except on an M-Pesa-paid session, where it is always `KES`** regardless of the payout currency, because `amount_local` and `exchange_rate` on those sessions describe the pay-in, not the payout.
- `receipt` mirrors `settlement_receipt`. Its form varies with the payout rail — a mobile-money receipt number on some, an on-chain transaction hash on others. Treat it as an opaque reference for reconciliation and support, not something to parse.
- **Optional fields are omitted from the webhook payload when unset**, not set to `null` — `external_id`, `amount_local`, `exchange_rate`, `receipt`, `completed_at`, `amount_received_usdc`, and `amount_matched` all disappear when they have no value. This is the opposite of the status endpoint's base fields, which keep the key and carry `null`. Write your webhook checks against a missing key.
- The field names differ from the status endpoint: `receipt` (not `settlement_receipt`), `external_id` (not present on the status endpoint at all), and there is no `deposit_address`, `description`, or `expires_at`.

Signed with HMAC-SHA256 over the raw request body using your webhook secret, in the `X-Minisend-Signature` header (lower-case hex). The header is only attached when a webhook secret is configured — treat a missing signature as a configuration problem to fix, not a reason to skip verification. Verify against the raw bytes, not a re-serialized parse.

A delivery your endpoint does not acknowledge with a 2xx is retried with backoff, so any event can arrive more than once. **Deduplicate on `session_id` plus `event`, not on `session_id` alone** — a session can deliver two different event names, and a `checkout.completed` that legitimately follows an outcome you already recorded (an M-Pesa session completing after its window closed) would be dropped as a duplicate. Deduplicate; do not seal. Full delivery and retry detail is in `references/webhooks.md`.

## Settlement

**An account settles one of two ways, and it changes what "completed" means.**

| Mode | What happens when a session completes |
| --- | --- |
| `fiat` | The proceeds are converted and paid out to the local payout account on file. |
| `usdc` | The proceeds stay in USDC and are moved to the account's settlement chain. No local currency is involved. |

The mode is a property of the account, but `POST /api/merchant/checkout` accepts `settlement_mode` and `settlement_chain` per session if you need to override it. Read the current configuration from `GET /api/merchant/settlement` rather than assuming.

The rest of this section describes `fiat`. For `usdc`, the money never becomes local currency: there is no `amount_local`, no `exchange_rate`, no payout receipt, and `forward` on the status endpoint is what tells you where the funds are.

### Settling in local currency

A session that reaches `completed` has been paid out in local currency to the payout account configured on your Minisend account — the mobile money number, till, paybill, or bank account you set in the dashboard. The payout destination is a property of the account, not of the session; there is no per-session payout field and no way to redirect one session's proceeds. To change where money lands, change the account's payout configuration.

`amount_local`, `exchange_rate`, and `settlement_receipt` on a `completed` session describe that payout. Read them back; do not compute the local amount from a rate you fetched earlier.

**One exception: an M-Pesa-paid session does not run a payout leg.** The customer pays KES and the equivalent USDC is released to the session's deposit address on Base, where it stays. The session still completes and still fires `checkout.completed`, and `settlement_receipt` still carries a receipt — but nothing is paid out to the local account for that session. `payment_method` on the session and on the webhook is how you tell the two apart, and if you are reconciling a local bank or mobile money statement against completed sessions, you must filter on it.

A Minisend fee applies to checkout, and **the two creation paths treat it differently**:

- **Payment link** (`POST /api/merchant/pay`) — you name the net the business should receive, and the customer covers the fee on top. `amount_usdc` in the response is the total to charge. For some payout currencies it comes back equal to the net you sent, so treat "equal" as a normal result and not a sign that the gross-up failed — either way, read `amount_usdc` back rather than deriving it.
- **Authenticated create** (`POST /api/merchant/checkout`) — no gross-up. `amount` is exactly what the customer sends, and the fee comes out on the payout side, so the local amount that lands is less than a straight conversion of `amount`. If you need the business to net a specific figure on this path, gross it up yourself before you call.

For current rates and fee terms, contact Minisend at `info@minisend.xyz`.

## Reading your configuration and balances

Two read-only endpoints for building your own dashboard instead of using Minisend's. Both take an `ms_live_` key with the `checkout` scope — the same key you already create sessions with, no new scope to request.

### `GET /api/merchant/settlement`

```json
{
  "settlement_mode": "usdc",
  "settlement_chain": "ARB",
  "platform_fee_rate": 0,
  "platform_fee_basis": "usdc",
  "payout_currency": "KES",
  "available_chains": [
    { "value": "BASE", "label": "Base", "requires_forward": false },
    { "value": "ARB", "label": "Arbitrum", "requires_forward": true }
  ]
}
```

`available_chains` is the set you may pass as `settlement_chain`, with a display label and whether reaching that chain requires a forward after each payment. Only Base does not.

**`platform_fee_rate` alone is ambiguous. `platform_fee_basis` tells you what it is a rate on**, so read them together and never the rate by itself.

| `platform_fee_basis` | What the rate applies to |
| --- | --- |
| `usdc` | A fraction of the USDC deposit, taken out of it. |
| `local` | A fraction of the **local-currency payout**, not of the USDC amount. Applying it to the USDC figure understates the fee. |
| `in_rate` | The rate is `0` because the margin sits in the exchange rate instead of a separate fee. |

`net = amount * (1 - platform_fee_rate)` is therefore wrong on `local` and badly wrong on `in_rate`, where it reports the payout as free. Branch on the basis. For fee terms contact `info@minisend.xyz`.

**This endpoint is read-only.** Changing the mode or chain provisions wallets and moves where money lands, so it stays in the dashboard behind a human confirmation. There is no API write.

### `GET /api/merchant/balances`

Per-chain USDC balances for the account.

```json
{
  "settlement_chain": "ARB",
  "balances": [
    { "chain": "BASE", "label": "Base", "address": "0x1234…", "balance_usdc": 0, "balance_available": true, "is_settlement_chain": false },
    { "chain": "ARB", "label": "Arbitrum", "address": "0x1234…", "balance_usdc": 0, "balance_available": true, "is_settlement_chain": true }
  ],
  "total_usdc": 0,
  "total_available": true
}
```

Only chains the account actually holds a wallet on are listed — Base always, plus any chain it has been forwarded to. A chain missing from the array has never been used, not "has zero".

**`null` does not mean zero, and this is the one thing on this endpoint that matters.**

- `balance_usdc: null` means that chain's lookup failed. The money is not gone; it could not be read.
- `total_usdc: null` means at least one chain failed, so no total is offered rather than a confident number that silently omits a chain.

Treating either `null` as `0` tells a merchant their balance vanished. Render "unavailable" and retry.

**Two booleans say the same thing without you having to reason about `null`.** `balance_available` is `false` on any chain whose lookup failed, and `total_available` is `false` when at least one did. Branch on those rather than on the nulls, since a boolean is much harder to coerce by accident than a `null` is.

| Status | Body | Meaning |
| --- | --- | --- |
| `409` | `{ "error": "No wallet provisioned for this account." }` | The account has no deposit wallet yet. Not retryable. |
| `503` | `{ "error": "Could not read balances right now. Please retry." }` | A lookup the endpoint refuses to guess past. Retry. |
| `500` | `{ "error": "Failed to fetch balances" }` | Unexpected failure. Retry. |

**A note on scope.** These are gated by `checkout`, which is enabled by default on every account — so any `ms_live_` key that can create a session can also read your per-chain balances, total, and addresses. It cannot move funds. If you put a checkout key somewhere you would not put treasury figures, that is worth knowing before you ship.

## Worked example

Server-side session creation, redirect, and webhook handling.

```ts
const BASE = 'https://merchant.minisend.xyz'
const RAW_KEY = process.env.MINISEND_API_KEY // ms_live_… — SERVER SIDE ONLY
if (!RAW_KEY) throw new Error('MINISEND_API_KEY is not set')
// Re-bind as `string` so the guard narrows inside the function below too —
// TypeScript does not carry module-level narrowing into a function body.
const KEY: string = RAW_KEY

// Call this from your route handler / controller. It must stay server side.
export async function startCheckout() {
  // 1. Create the session. This is the ONLY checkout call that takes a key,
  //    and the only one that accepts external_id.
  const res = await fetch(`${BASE}/api/merchant/checkout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: 25,
      description: 'Order #1183',
      external_id: 'order_1183', // your join key — the webhook echoes it back
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${body.error ?? JSON.stringify(body)}`)

  const session = body as {
    session_id: string
    checkout_url: string
    deposit_address: string
    amount_usdc: number
    expires_at: string
  }

  // 2. Send the customer to the hosted page — however your framework redirects.
  //    Quote them session.amount_usdc EXACTLY. An off-amount payment is not
  //    rejected: with one session open it settles for whatever actually arrived
  //    (so an underpayment still completes — check amount_received_usdc on the
  //    webhook); with several open it parks for manual review and fires nothing.
  return { redirectTo: session.checkout_url }
}
```

Polling, if you need a status in the browser while the customer waits. This endpoint is **public** — call it directly from client code, with no key and no proxy:

```ts
type SessionView = {
  status: string
  payment_method: 'crypto' | 'mpesa'
  awaiting_onramp: boolean
  settlement_receipt?: string | null
}
const DONE = new Set(['completed', 'failed', 'expired'])

async function poll(sessionId: string, expiresAt: string) {
  const deadline = new Date(expiresAt).getTime()
  for (;;) {
    const r = await fetch(`${BASE}/api/merchant/checkout/${sessionId}`)
    const s: SessionView = await r.json()
    if (DONE.has(s.status)) return s
    // Past the window, a read flips a pending session to expired. There is
    // no expiry webhook either way, so reconcile server-side from here.
    if (Date.now() >= deadline) return s
    await new Promise((r) => setTimeout(r, 3000))
  }
}
```

The webhook is the path to actually rely on:

```ts
import crypto from 'node:crypto'

const RAW_SECRET = process.env.MINISEND_WEBHOOK_SECRET
// Fail closed at boot. Never silence this check with a non-null assertion: a
// blank value keys the HMAC on the empty string, and the comparison below
// would then accept anything signed with it.
if (!RAW_SECRET) throw new Error('MINISEND_WEBHOOK_SECRET is not set')
// Re-bind as `string` so the guard narrows inside the function body too.
const SECRET: string = RAW_SECRET

// Verify over the RAW body. Re-serializing the parsed JSON breaks the signature.
export function handleWebhook(rawBody: string, signature: string) {
  const expected = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('bad signature')
  }

  const event = JSON.parse(rawBody)
  switch (event.event) {
    case 'checkout.completed':
      // Optional fields are OMITTED when unset here — check for absence,
      // not for null. Idempotent: this can be redelivered, and can arrive
      // for a session you already saw expire (M-Pesa late confirmation).
      return fulfil(event.external_id, {
        receipt: event.receipt,               // may be absent
        localAmount: event.amount_local,      // may be absent
        // An M-Pesa session completes WITHOUT a local-currency payout.
        paidOut: event.payment_method !== 'mpesa',
      })
    case 'checkout.failed':
      return markFailed(event.external_id)
  }
  // checkout.expired is delivered too — add a case for it if you want to
  // mark abandoned orders. Reconciling from expires_at remains a fine backstop.
}
```

## Common mistakes

- **Calling `POST /api/merchant/checkout` from the browser.** It needs an `ms_live_` key. Create the session on your server and hand the browser the `checkout_url`.
- **Proxying the public endpoints to attach a key.** `GET /api/merchant/checkout/{session_id}`, both M-Pesa endpoints, and all three payment-link endpoints ignore the `Authorization` header entirely. A backend proxy in front of them adds latency and nothing else.
- **Treating `deposit_address` as session-specific.** It is the same address for every session on the account. It is not a session identifier, and a payment to it proves nothing about which session it belongs to.
- **Quoting `merchant_amount_usdc` to the customer.** On the payment-link path the customer must send `amount_usdc`, which is the grossed-up total. Read it back; never compute it.
- **Assuming `amount_usdc` equals what you asked for on the payment-link path.** It does not, in general.
- **Reconciling on `amount_usdc`.** It is the amount you asked for, not the amount that arrived. An underpayment still completes the session. Book `amount_received_usdc`.
- **Polling a session past `expires_at` and expecting it to stay `pending`.** The read expires it.
- **Reading a `null` check written for the status endpoint against the webhook payload.** The status endpoint keeps keys and sets `null`; the webhook drops them. And the status endpoint's `amount_local`, `exchange_rate`, `settlement_receipt`, and `completed_at` are a third case — absent entirely until the session completes.
- **Counting an M-Pesa-paid completed session as money in the local payout account.** It is not; that path releases USDC to the deposit address and runs no payout leg. Filter on `payment_method`.
- **Reading a still-`pending` session after a failed M-Pesa prompt as "still ringing."** A failed prompt reverts the session to plain `pending` with `awaiting_onramp: false`. Check the flag, not the status.
- **Retrying an M-Pesa prompt through the 409 cooldown.** It is a double-charge guard. Surface the message and wait.
- **Hardcoding the six chain codes.** Read `accepted_chains` from the session — a deposit on a chain the account does not accept will not settle it.
- **Relying on `external_id` from a payment-link session.** The public create path does not accept one. Use the authenticated endpoint when you need to reconcile.
- **Treating the `status` parameter on your return URL as proof of payment.** It is a query parameter a customer can type. Confirm with the webhook or a server-side status read before releasing anything.
- **Expecting `redirect_url` on a payment-link session.** Only the authenticated create path accepts one.
- **Assuming the two amount ceilings match.** The payment-link path caps at 10,000 USDC; the authenticated create path's ceiling is higher and is reported in its own error message.
