# On-ramp

## What it does

On-ramp is the inbound half of Minisend: you collect local currency from a paying customer and receive USDC at a wallet address you nominate. It has two rails, picked by `currency`:

- **`KES`** — an M-Pesa payment prompt. You name the customer's phone number and your own release address; Minisend sends a payment prompt to that phone; when the customer approves it on their handset, USDC is released on Base to your address.
- **`NGN`** — a bank transfer. Minisend returns a virtual bank account; you show it to the customer; the customer transfers naira from their own bank; USDC is released on Base to your address once the transfer lands. Nothing is pushed to the customer here — there is no prompt, no PIN entry, no handset step.

The customer — the **payer** — is the party being charged, on either rail. You — the **integrator** — are the party receiving value. The address on the order is yours, not theirs. Both rails share auth, rate limits, order shape, and webhook events; they differ in what you provide at order creation and in the object the API hands back for the customer to act on.

Off-ramp is the mirror image: USDC in, local currency out to a recipient. See `references/offramp.md`. In on-ramp there is no recipient; nobody is paid out in local currency.

Base URL: `https://merchant.minisend.xyz`

## Requirements

- An `ms_live_` API key carrying the `onramp` scope.
- The on-ramp capability enabled on your account.

Both gates must pass, and both fail with the identical 403 — you cannot tell from the response which one is missing, and you must not build logic that tries:

```json
{ "error": "Your account doesn't have onramp access yet. Please contact info@minisend.xyz to request access." }
```

Read `references/authentication.md` before writing request code; it covers the key format, the 403 model, and rate limits.

If on-ramp is switched off platform-wide, every endpoint here returns `503 { "error": "Onramp API is not available." }`.

**Rate limits.** The general limit is applied per calling client (by IP), not per key. On top of it, on-ramp carries caps of its own:

| Cap | Scope | Limit | Message on 429 |
| --- | --- | --- | --- |
| Order creation | Per account, both currencies share the cap | 10 per minute | `Too many onramp orders created recently. Please slow down, or contact info@minisend.xyz if you need a higher limit.` |
| Payment prompts to one phone (KES only) | Per phone number, across **all** accounts | 5 per 10 minutes | `Too many payment requests sent to this phone number recently. Please wait before retrying.` |
| Orders per payer bank account (NGN only) | Per `refund_account`, across **all** accounts | 5 per 10 minutes | 429, per-bank-account limit — see [Limits](#limits) |

The order-creation cap is shared across KES and NGN — it's a single per-account budget, not one each. The per-phone and per-bank-account caps are not yours to spend alone — another integrator's traffic against the same phone number or the same payer bank account counts against it, and so do your own retries. The account cap is consumed by *every* create call, including calls that replay an `Idempotency-Key` and create nothing.

## The flow

1. **Quote** (optional) — `POST /api/onramp/quote`. Prices the collection so you can show the customer what they will be charged. Nothing is created and no prompt is sent, no account is issued.
2. **Create the order** — `POST /api/onramp/orders`. On KES this **immediately sends the payment prompt to the customer's phone**. On NGN this **immediately issues a virtual bank account** for the customer to transfer into. The order comes back `pending` either way.
3. **The customer pays** — approves the KES prompt on their handset and enters their PIN, or transfers naira to the NGN account from their own bank. You have no API control over either step.
4. **Minisend releases USDC on Base** to your `release_address`.
5. **Receive the webhooks** — `onramp.completed` when the cash is collected, `onramp.released` when the on-chain transfer is recorded. Or poll `GET /api/onramp/orders/{order_id}`.

**Both rails are one-shot.** The KES prompt fires once, at creation, with no endpoint to re-send it. The NGN account is minted once, at creation, and stops being usable once it expires or the order leaves `pending` — there is no endpoint to reissue it either. If the customer cancels the prompt or doesn't complete the payment in time, the order ends `cancelled`, `failed` or `expired` and stays that way — you create a **new order** to try again. This is deliberate on both rails: it makes it structurally impossible for one order to charge a customer twice.

## Bank codes (NGN)

`GET /api/onramp/institutions?currency=NGN` — requires the `onramp` scope. Lists the banks a payer's `refund_account` can name, with the code each one is identified by.

`refund_account.institution` is an opaque code with no way to guess it, and a wrong code fails order creation. Read the list rather than hardcoding one.

Response `200`:

```json
{
  "currency": "NGN",
  "count": 0,
  "institutions": [
    { "code": "GTBINGLA", "name": "Guaranty Trust Bank", "type": "bank" }
  ]
}
```

If you already integrated off-ramp's NGN payout path, you've seen this shape before: `GET /api/offramp/institutions?currency=NGN` returns the same list. Either endpoint works for sourcing a code to put in `refund_account.institution` — you don't need to call both.

## Endpoint reference

> **About the numbers in the sample responses below.** Every priced field — `rate`, `amount_kes`, `fee_kes`, `net_kes`, `amount_ngn`, `fee_ngn`, `net_ngn`, `amount_local`, `fee` — is shown as `0`. That is a placeholder, not a value. Read the real figures from the live response; never hardcode them and never derive one from another. `payment_instructions.amount` is the one exception — it's shown as a real-looking string below because its exact string form is the point; see the note where it appears.

All requests use `Content-Type: application/json` and `Authorization: Bearer ms_live_…`.

### `POST /api/onramp/quote`

Prices a collection without creating anything. **No payment prompt is sent, no account is issued.** Nothing is reserved.

Request — `currency` plus exactly one amount field for that currency:

```json
{ "currency": "KES", "amount_usdc": 10 }
```

```json
{ "currency": "NGN", "amount_ngn": 10120 }
```

| Field | Required | Notes |
| --- | --- | --- |
| `currency` | no | `KES` or `NGN`. Upper-cased for you. Omitted or non-string defaults to `KES`; any other value is rejected. |
| `amount_usdc` | one of | The **net USDC you want to receive**. On KES the customer is charged the grossed-up local amount; on NGN, likewise, `amount_ngn` comes back grossed up. Positive finite number. |
| `amount_kes` | one of, KES only | The **exact KES the customer will be charged**. The fee is carved out of it and the remainder converts to USDC. Positive finite number, rounded to a whole number. |
| `amount_ngn` | one of, NGN only | The **exact NGN the customer will be charged**. Same shape as `amount_kes`: fee carved out, remainder converts to USDC. Positive finite number, at most 2 decimal places. |

Send both amount fields, or neither, and you get `400 { "error": "Provide exactly one of amount_usdc or amount_kes (positive number)." }` on KES, or the NGN equivalent below. The two directions are the same arithmetic read from opposite ends — pick whichever end your product fixes.

Response `200` — KES:

```json
{
  "currency": "KES",
  "payment_method": "mpesa",
  "amount_kes": 0,
  "fee_kes": 0,
  "net_kes": 0,
  "amount_usdc": 10,
  "rate": 0,
  "expires_at": "2026-07-31T10:35:00.000Z"
}
```

Response `200` — NGN:

```json
{
  "currency": "NGN",
  "payment_method": "bank_transfer",
  "amount_ngn": 0,
  "fee_ngn": 0,
  "net_ngn": 0,
  "amount_usdc": 7.14,
  "rate": 0,
  "expires_at": "2026-09-26T10:05:00.000Z"
}
```

- **`payment_method` names the rail** — `mpesa` for KES, `bank_transfer` for NGN. Both quote and order responses carry it; branch your UI copy on it rather than on `currency` alone if you ever add a second KES rail.
- **`amount_kes` / `amount_ngn` is what the customer will be asked for.** This is the figure to show them. It is the gross: `net_kes`/`net_ngn` plus `fee_kes`/`fee_ngn`.
- `net_kes` / `net_ngn` is the portion that converts to USDC.
- **`amount_usdc` is what your address receives.**
- `expires_at` on the quote is informational only. The quote reserves nothing, and order creation re-prices from scratch — so the amounts on the order can differ from the ones you quoted. Read them back from the order response. (This is a different `expires_at` from the one on the *order*, which is a real deadline — see [`POST /api/onramp/orders`](#post-apionramporders).)

Errors: `400 { "error": "Invalid JSON body." }`; `400 { "error": "currency must be KES (M-Pesa) or NGN (bank transfer)." }`; `400` for the amount rules above or an out-of-band amount (see [Limits](#limits)); `502 { "error": "Failed to generate quote." }` if pricing is unavailable.

### `POST /api/onramp/orders`

Creates the order and immediately triggers the customer-facing step for that rail: the KES prompt, or the NGN account issuance. A `201` here means a real phone is ringing (KES) or a real bank account now exists for this order (NGN).

Optional header: `Idempotency-Key: <your-unique-string>`. A replay with the same key returns the original order with status `200` and does **not** trigger a second prompt or a second account. Use it — see the warning below about what a replay returns after a failure.

#### KES request

```json
{
  "currency": "KES",
  "amount_usdc": 10,
  "phone": "+254712345678",
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "reference": "invoice-4471"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `currency` | no | `KES`; defaults to `KES`. |
| `amount_usdc` / `amount_kes` | one of | Exactly one, same rules as the quote. The order is priced server-side; client-supplied prices are never trusted. |
| `phone` | yes | The **paying customer's** Kenyan mobile number. Accepted input shapes are the same as off-ramp's — see `references/recipients.md`. Normalised to `0XXXXXXXXX`. |
| `network` | no | `Safaricom`, overriding auto-detection. See the note below — this field is fussier than it looks. |
| `address` | yes | **Your own** wallet address, `0x` + 40 hex characters. Where the USDC is released, on Base. Lower-cased on the order. |
| `reference` | no | Your own identifier. **Note the asymmetry: you send `reference`, and it comes back as `external_reference`** on the order and on the webhook. |

There is no `refund_address` on a KES order and no recipient object — nothing is paid out in local currency, so neither applies. (NGN does have a refund concept, but it's shaped differently — see below.)

**The `network` field behaves differently from off-ramp's `mobile_network`.** Off-ramp normalises forgivingly (`references/recipients.md` documents the aliases and case-folding). Here, only the exact string `Safaricom` is honoured as an override; `Airtel` is refused with a `400` (Airtel Money isn't supported for collections), and anything else — `safaricom`, `mpesa`, `SAFARICOM` — is **silently ignored** rather than rejected, and the carrier is auto-detected from the number's prefix instead. Auto-detection is the better path: leave `network` out unless you have a specific reason, such as a number ported to Safaricom from another network. And note that a `Safaricom` override *replaces* the carrier check entirely, so overriding a number that isn't actually on Safaricom produces an order that fails when the prompt is sent rather than a clean `400`.

Response `201` — KES:

```json
{
  "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
  "status": "pending",
  "currency": "KES",
  "payment_method": "mpesa",
  "amount_usdc": 10,
  "amount_local": 0,
  "fee": 0,
  "rate": 0,
  "customer_phone": "0712345678",
  "mobile_network": "Safaricom",
  "release_address": "0x1234567890abcdef1234567890abcdef12345678",
  "release_chain": "base",
  "release_asset": "USDC",
  "receipt_number": null,
  "release_tx_hash": null,
  "failure_reason": null,
  "external_reference": "invoice-4471",
  "expires_at": "2026-07-31T11:00:00.000Z",
  "completed_at": null,
  "created_at": "2026-07-31T10:30:00.000Z",
  "instructions": "The customer's phone (0712345678) will receive an M-Pesa prompt for KSh 0. On payment, 10 USDC (Base) is released to release_address."
}
```

- **`amount_local` is the gross the customer is charged**, the same figure as `amount_kes` on the quote. `fee` is the Minisend fee already included in it. `amount_usdc` is what you receive.
- `customer_phone` is the normalised local form — read it back rather than assuming your input format survived.
- `release_chain` is `base` and `release_asset` is `USDC` on every order today, either rail.
- `expires_at` on a KES order is 30 minutes from creation. The prompt itself dies on the handset much sooner (a minute or two); the longer window covers slow confirmations before the order is swept to `expired`.
- Fields that only populate once the order progresses: `receipt_number`, `release_tx_hash`, `failure_reason`, `completed_at`. **On the order object these keys are always present and carry `null` until they are set** — they are not omitted. Test them for truthiness or for `null`; `=== undefined` and `'release_tx_hash' in order` both give the wrong answer here.

  **This differs from the webhook payload**, where the same fields *are* dropped entirely when unset. The two surfaces genuinely behave differently, so a null-check that works on one will not work on the other. See [Webhook events](#webhook-events).

The `instructions` string is generated per order:

> The customer's phone (`<customer_phone>`) will receive an M-Pesa prompt for KSh `<amount_local>`. On payment, `<amount_usdc>` USDC (Base) is released to release_address.

Errors:

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "error": "Invalid JSON body." }` | Body wasn't valid JSON. |
| `400` | `{ "error": "address is required and must be a valid 0x EVM address (Base USDC release destination)." }` | Missing or malformed release address. First of the body-field checks — but the availability flag, auth, the per-account creation cap, and JSON parsing all run before it, so a bad address still costs you one of your ten creates per minute. |
| `400` | `{ "error": "phone is required." }` | No `phone`. |
| `400` | `{ "error": "Please enter a valid Kenyan phone number." }` | `phone` isn't a recognisable Kenyan mobile shape. |
| `400` | `{ "error": "This Kenyan number doesn't look right. Please check it and try again." }` | Right shape, but the prefix isn't allocated to any known carrier. |
| `400` | `{ "error": "Only Safaricom M-Pesa numbers are supported." }` | A real Kenyan number that isn't on Safaricom M-Pesa (Airtel, Telkom, Equitel and smaller networks), or `network: "Airtel"`. |
| `400` | `{ "error": "currency must be KES (M-Pesa) or NGN (bank transfer)." }` | `currency` was something other than `KES` or `NGN`. |
| `400` | `{ "error": "Provide exactly one of amount_usdc or amount_kes (positive number)." }` | Both amounts, neither, or a non-positive one. |
| `400` | Amount messages in [Limits](#limits). | Below the minimum, or outside the supported band. |
| `429` | Creation or per-phone cap. | See [Requirements](#requirements). |
| `502` | `{ "error": "Failed to price the order." }` | Pricing unavailable. Nothing created. |
| `500` | `{ "error": "Failed to create order." }` | Order could not be recorded. Nothing created. |
| `502` | `{ "error": "Failed to start the M-Pesa payment: <detail>. Create a new order to retry." }` | The order **was** created and is now `failed`. No prompt reached the customer. |

**That last one deserves care.** The order exists, it is `failed`, and the response body carries no `order_id` — so you have no handle on it. Worse, if you retry with the **same** `Idempotency-Key`, you get `200` and that same `failed` order back, and no prompt is sent. Retry with a **new** `Idempotency-Key`, exactly as the message says.

#### NGN request

```json
{
  "currency": "NGN",
  "amount_ngn": 10120,
  "refund_account": {
    "institution": "GTBINGLA",
    "account_number": "0123456789",
    "account_name": "John Doe"
  },
  "address": "0xYourBaseAddress…",
  "reference": "order-8841"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `currency` | yes | `NGN`. |
| `amount_ngn` / `amount_usdc` | one of | `amount_ngn` (≤ 2 decimal places) is the exact total the customer transfers; `amount_usdc` (≤ 6 decimal places) is the USDC you want to receive. Exactly one. The order is priced server-side; client-supplied prices are never trusted. |
| `refund_account` | yes | The **payer's own** bank account — where their naira goes back if the order fails after they've already paid. See below. |
| `address` | yes | **Your own** wallet address, `0x` + 40 hex characters. Where the USDC is released, on Base. Lower-cased on the order. |
| `reference` | no | Your own identifier. Comes back as `external_reference`, same asymmetry as KES. |

`refund_account` is the NGN rail's equivalent of a required field, not an optional courtesy — it's how the customer gets their money back if the transfer arrives but the order can't be completed:

| Field | Required | Notes |
| --- | --- | --- |
| `institution` | yes | A bank code from [Bank codes](#bank-codes-ngn). An unrecognised code fails order creation. |
| `account_number` | yes | A 10-digit NUBAN. |
| `account_name` | usually no | The name is looked up from the bank automatically. Supply it only if the bank returns no name for that account — you'll know because you get a `422` asking for it specifically. Sending it unprompted doesn't override the looked-up name; the order carries the bank's version. |

There is no `phone`, no `network`, and no M-Pesa-shaped field anywhere on an NGN order. `customer_phone` and `mobile_network` still appear on the order and webhook payload, for shape consistency across both rails, but they are always `null` for NGN.

Response `201` — NGN:

```json
{
  "order_id": "…",
  "status": "pending",
  "currency": "NGN",
  "payment_method": "bank_transfer",
  "amount_usdc": 7.14,
  "amount_local": 10120,
  "fee": 0,
  "rate": 0,
  "customer_phone": null,
  "mobile_network": null,
  "refund_account": {
    "institution": "GTBINGLA",
    "account_number": "0123456789",
    "account_name": "JOHN DOE"
  },
  "payment_instructions": {
    "method": "bank_transfer",
    "bank_name": "Guaranty Trust Bank",
    "account_number": "9876543210",
    "account_name": "Provider A / John Doe",
    "amount": "10120.00",
    "currency": "NGN",
    "expires_at": "2026-09-26T10:30:00Z",
    "note": "Transfer exactly this amount, kobo included, before expires_at. A different amount or a late transfer will not be credited."
  },
  "release_address": "0x…",
  "release_chain": "base",
  "release_asset": "USDC",
  "external_reference": "order-8841",
  "expires_at": "2026-09-26T10:30:00Z",
  "created_at": "…",
  "instructions": "Ask the payer to transfer exactly NGN 10120 to … before …"
}
```

Fields worth calling out individually, because getting any one of them wrong is how integrations lose real transfers:

- **`payment_instructions.amount` is a string, and you must show it exactly as returned.** It can carry kobo — `"9108.03"`, not just whole naira. Don't round it, don't reformat it, and don't compute your own figure from `amount_local` instead. A transfer for a different amount than this exact string is not credited, full stop.
- **The account is valid only until `payment_instructions.expires_at`.** Read that timestamp from the response you actually got back; don't assume a fixed window, and don't reuse a duration you observed on a previous order. Show the customer a countdown against it.
- **`payment_instructions` exists only while `status` is `pending` and the account is still valid.** It disappears from the order once the status moves on — including to `deposit_received`. Don't cache it past its own `expires_at`, and don't keep showing it once the order has moved past `pending`.
- **`amount_local` is authoritative after creation.** It's the amount the customer is actually being asked to transfer — the same number that ends up (as a string, with kobo) in `payment_instructions.amount`.
- `refund_account` on the response echoes what you sent, with `account_name` replaced by the bank's own version of the name.
- `amount_usdc`, `fee`, `rate` follow the same placeholder convention as the KES fields above — read the live figures back, never hardcode them.

Errors, NGN-specific:

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "error": "Provide exactly one of amount_ngn or amount_usdc (positive number)." }` | Both amounts, neither, or a non-positive one. |
| `400` | `{ "error": "amount_ngn must be a positive number with at most 2 decimal places." }` | `amount_ngn` failed the shape check. |
| `400` | `{ "error": "refund_account is required…" }` | No `refund_account` object at all. |
| `400` | `{ "error": "refund_account.institution is required…" }` | Missing bank code. |
| `400` | `{ "error": "refund_account.account_number must be a 10-digit Nigerian account number." }` | `account_number` isn't a 10-digit NUBAN. |
| `400` | Amount messages in [Limits](#limits). | Below the minimum, or over the per-order NGN ceiling. |
| `400` | `{ "error": "currency must be KES (M-Pesa) or NGN (bank transfer)." }` | `currency` was something other than `KES` or `NGN`. |
| `422` | `{ "error": "refund_account could not be verified. Check the bank code and account number." }` | The bank code and account number don't resolve to a real account. Nothing created; fix the details and call again. |
| `422` | `{ "error": "refund_account.account_name is required: this bank does not return account names." }` | The bank has no name lookup for this account. Supply `refund_account.account_name` and retry. |
| `429` | Per-account creation cap, or per-`refund_account` cap — see [Requirements](#requirements) and [Limits](#limits). | Back off. |
| `502` | `{ "error": "Failed to price the order." }` | Pricing unavailable. Nothing created. |
| `502` | `{ "error": "Failed to create the bank transfer account. Create a new order to retry." }` | The order could not get a usable virtual account. Create a new order — same as the KES `502`, a fresh attempt needs a fresh order, and a fresh `Idempotency-Key` if you're setting one. |
| `502` | `{ "error": "The price moved while creating this order. Create a new order to retry." }` | The rate shifted between quote-time pricing and account issuance. Create a new order. |

**Idempotency behaves the same as KES: replaying the same `Idempotency-Key` returns the original order, never a second account.** That's true whether the original order succeeded or failed — so, exactly as with the KES `502`, a retry after a `502` needs a **new** key, or you'll get the same dead order back with no new account minted.

### `GET /api/onramp/orders/{order_id}`

Response `200`: the order object, same shape as the creation response minus `instructions`. On an NGN order this includes `refund_account`, and `payment_instructions` for as long as the order is `pending` and the account is still valid.

Reading a `pending` order whose `expires_at` has passed flips it to `expired` and returns the expired order — with a consequence for webhooks, described in [Webhook events](#webhook-events).

`404 { "error": "Order not found." }` for an unknown order *and* for one owned by another account — you cannot distinguish them, by design.

### `GET /api/onramp/orders`

Lists your orders, newest first by creation time, KES and NGN mixed together.

Query parameters:

| Parameter | Default | Notes |
| --- | --- | --- |
| `status` | — | Filter by one status string. |
| `limit` | `20` | Capped at 100. |
| `offset` | `0` | Non-positive or non-numeric values are clamped to 0. |

Response `200`:

```json
{
  "orders": [
    {
      "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
      "status": "completed",
      "currency": "KES",
      "payment_method": "mpesa",
      "amount_usdc": 10,
      "amount_local": 0,
      "fee": 0,
      "rate": 0,
      "customer_phone": "0712345678",
      "mobile_network": "Safaricom",
      "release_address": "0x1234567890abcdef1234567890abcdef12345678",
      "release_chain": "base",
      "release_asset": "USDC",
      "receipt_number": "SLJ7K2P9QX",
      "release_tx_hash": "0xabc…",
      "external_reference": "invoice-4471",
      "expires_at": "2026-07-31T11:00:00.000Z",
      "completed_at": "2026-07-31T10:32:41.000Z",
      "created_at": "2026-07-31T10:30:00.000Z"
    }
  ],
  "total": 137,
  "limit": 20,
  "offset": 0
}
```

Each element is a **complete order object** — the same shape the single-order endpoint returns, `payment_method` and (for NGN) `refund_account` included. No follow-up fetch needed. `payment_instructions` is included on an NGN element too, but only for as long as the same rules in [`POST /api/onramp/orders`](#post-apionramporders) hold — it's absent once the order has left `pending` or the account has expired.

`total` is the count of all matching orders, not the page — paginate with `offset` until `offset + limit >= total`.

Unlike the single-order read, listing does **not** expire stale `pending` orders.

## Order lifecycle

The complete status vocabulary. These exact strings appear on the order, in the `status` query parameter, and on the webhook payload.

| Status | Meaning | Rail | Final? |
| --- | --- | --- | --- |
| `pending` | Order created; prompt sent (KES) or account issued (NGN); waiting on the customer. | both | no |
| `deposit_received` | The naira transfer arrived; USDC is being released. | **NGN only** | no |
| `completed` | The local currency was collected. `completed_at` is set, and `receipt_number` carries the customer's payment receipt (KES) or the order's own receipt reference (NGN). | both | **yes** |
| `failed` | The payment did not go through, or went through but couldn't be completed. `failure_reason` is set. | both | in practice |
| `cancelled` | The customer dismissed the M-Pesa prompt themselves. Nothing was charged. `failure_reason` is set (`stk_failed: <detail>`). | **KES only** | in practice |
| `expired` | The order window closed with no confirmed payment. | both | in practice |

**`deposit_received` exists only on the NGN rail.** KES goes straight from `pending` to an end state, same as before; NGN has this one extra waypoint between "we've issued an account" and "you're paid," because the naira can land measurably before the USDC release completes. **Once an order reaches `deposit_received`, stop showing the customer the bank account** — `payment_instructions` is gone from the response by then anyway, and the money has already moved. Completion typically follows within a couple of minutes of the transfer landing.

**`completed` is the only strictly immutable status, on either rail.** `failed`, `cancelled` and `expired` are end states you should treat as terminal for your own flow control — nothing further is expected, and a new order is the way forward — but they are not sealed: if a late confirmation shows the customer's money *was* collected, the order still moves to `completed` and `onramp.completed` fires. This is deliberate; the customer was charged, so the order has to reflect that. The practical rule: **keep handling `onramp.completed` for an order even after you have seen it `expired`, `failed` or `cancelled`,** and never mark a payment permanently abandoned in your own system without being idempotent about a later completion.

The reverse never happens — an order that is `completed` or `expired` is never moved to `failed` or `cancelled`.

**`cancelled` is not a kind of `failed`.** It has its own status and its own event, `onramp.cancelled`; a cancelled order never sends `onramp.failed`. A handler that only listens for `onramp.failed` will see a cancelled order as one that never finished. Treat both as "no payment, create a new order if the customer still wants to pay," but keep them apart if you report on them: a cancellation is the customer's choice, a failure is not. NGN orders never reach `cancelled`; NGN's own `failure_reason` value `cancelled` (below) sits on a `failed` order and is unrelated to this status.

`release_tx_hash` is the on-chain transfer of USDC to your `release_address`. It is recorded independently of the status transition and usually lands shortly after `completed` — but the two are separate events and either order is possible. `receipt_number` is the local payment receipt from the customer's confirmation.

### `failure_reason` values (NGN)

An NGN order's `failure_reason` is not a free-text diagnostic the way KES's `stk_failed: <detail>` is — it's a small closed set, and what you should do differs by value:

| `failure_reason` | What happened | What to do |
| --- | --- | --- |
| `refunded_to_payer` | The naira was received but the order couldn't complete, so it was sent back to the customer's `refund_account`. | Nothing to reconcile on your side beyond marking the order failed — the customer already has their money back. |
| `deposit_not_settled` | The naira was received but the order could not settle. | **Contact support with the `order_id`. Do not ask the customer to pay again** — their money is already in, and a second transfer would be a second charge with no order to credit it against. This is the one value on this list that is not "create a new order." |
| `cancelled` | The order was cancelled before a transfer was completed. | Create a new order if the customer still wants to pay. |
| `provision_failed` | The order never got a usable virtual account. | Create a new order. |
| `persist_failed` | The order never got a usable virtual account (a different internal cause, same customer-facing outcome). | Create a new order. |
| `price_moved` | The rate shifted enough between pricing and account issuance that the order never got a usable virtual account. | Create a new order — same as the `502 The price moved while creating this order.` at creation time, just discovered slightly later. |

The three `_failed`/`price_moved` values all mean the same thing from your side: no money moved, no account exists, start over. `deposit_not_settled` is the one that needs a human, not a retry — treat it differently in your handling code, not just in your support runbook.

## Webhook events

On-ramp emits four events to your configured webhook URL, shared across both rails:

| Event | Fires when |
| --- | --- |
| `onramp.completed` | The local currency was collected. Order is `completed`. Fires first. |
| `onramp.released` | The on-chain USDC transfer to `release_address` was recorded. **Carries `release_tx_hash`. Does not change the order's status.** |
| `onramp.failed` | The payment did not produce a completed order. Order is `failed`. |
| `onramp.cancelled` | KES only. The customer dismissed the M-Pesa prompt. Order is `cancelled`. |
| `onramp.expired` | The order window closed unpaid. Order is `expired`. |

`onramp.released` is the one with no off-ramp equivalent, and the one most likely to surprise you: it is a *money-arrived* signal, not a state change. On KES, the gap between `onramp.completed` and `onramp.released` can be real — the on-chain hash isn't always known the instant the collection is confirmed. **On NGN, the two typically arrive close together**, since the release follows the confirmed bank transfer without a separate handset-confirmation step in between — but no ordering between them is guaranteed on either rail, so don't build logic that assumes one always precedes the other. If you credit a user on `onramp.completed`, treat `onramp.released` as your on-chain receipt; if you need the funds confirmed on Base before crediting, key off `onramp.released` instead.

**There is no webhook for `deposit_received`.** It's a real status you can read from `GET /api/onramp/orders/{order_id}`, but nothing is pushed when an order enters it. If you want to show the customer "we've received your transfer, releasing your USDC now," you have to poll for it — there's no event to hang that UI state on.

A delivery your endpoint doesn't acknowledge with a 2xx is retried, so any event can arrive more than once. Make your handler idempotent on `order_id` and `event` together — not on `order_id` alone, since one order legitimately produces two different events.

`onramp.expired` is delivered whichever way an unpaid order expires: the background sweep, or `GET /api/onramp/orders/{order_id}` observing a still-`pending`, past-window order and expiring it in-band. Delivery is retried but not guaranteed, so reconciling your own `pending` orders past `expires_at` remains a sound backstop, and an `expired` status on a read is terminal in its own right.

Payload — KES:

```json
{
  "event": "onramp.completed",
  "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
  "external_reference": "invoice-4471",
  "status": "completed",
  "currency": "KES",
  "payment_method": "mpesa",
  "amount_usdc": 10,
  "amount_local": 0,
  "fee": 0,
  "exchange_rate": 0,
  "customer_phone": "0712345678",
  "mobile_network": "Safaricom",
  "release_address": "0x1234567890abcdef1234567890abcdef12345678",
  "receipt_number": "SLJ7K2P9QX",
  "release_tx_hash": "0xabc…",
  "completed_at": "2026-07-31T10:32:41.000Z",
  "created_at": "2026-07-31T10:30:00.000Z"
}
```

The same event on an NGN order carries `"currency": "NGN"`, `"payment_method": "bank_transfer"`, and **`customer_phone` and `mobile_network` as `null`** rather than omitted — the two payloads share one shape, and those two fields simply have no meaning on the bank-transfer rail. Everything else about the payload — field names, the omitted-when-unset convention, the placeholder-`0` convention — is identical between the two currencies.

The priced fields (`amount_local`, `fee`, `exchange_rate`) are `0` placeholders for the same reason as in the endpoint reference.

Note the field names differ from the order object: `exchange_rate` (not `rate`), and there is no `release_chain`, `release_asset`, or `expires_at`.

**Optional fields are omitted from the webhook payload when unset** — `failure_reason` appears on `onramp.failed` and `onramp.cancelled`, `release_tx_hash` on `onramp.released` and afterwards. This is the opposite of the order object, which keeps the key and sets it to `null`. Write your webhook checks against a missing key, and your order-object checks against `null`; a single shared helper that assumes one behaviour will misread the other surface.

Signed with HMAC-SHA256 over the raw request body using your webhook secret, in the `X-Minisend-Signature` header (lower-case hex). The header is only attached when a webhook secret is configured on your account — if none is set, deliveries arrive unsigned, so treat a missing signature as a configuration problem to fix rather than something to skip verification for. Verify against the raw bytes, not a re-serialized parse. Full delivery, retry, and verification detail is in `references/webhooks.md`.

## Currency support

**On-ramp collects KES or NGN.** KES via an M-Pesa payment prompt; NGN via a bank transfer to a virtual account. Nothing else, today.

Do not carry the off-ramp currency list over. Off-ramp pays out KES, NGN, GHS, and UGX; on-ramp collects KES or NGN only. Anything else is rejected outright:

```json
{ "error": "currency must be KES (M-Pesa) or NGN (bank transfer)." }
```

For KES, the only network is `Safaricom` (M-Pesa), with the same accepted phone-number input shapes as off-ramp. See `references/recipients.md` for the formats. Kenyan numbers on other carriers, Airtel included, are real numbers but have no route here, and are rejected with `Only Safaricom M-Pesa numbers are supported.` For NGN there is no phone or network concept at all — the customer is identified only by the bank transfer they make, and their `refund_account` is how money finds its way back to them if needed.

## Limits

### KES: 100 KES net minimum, 20–250,000 KES band

**The floor is 100 KES net — not the gross the customer is charged.** "Net" is the portion that converts to USDC, after the Minisend fee comes out of the total. Because the fee sits on top of the net, the amount the customer's phone is prompted for is always somewhat above 100 KES even for the smallest permitted order. This is the single most misread number in the on-ramp API, and it has been published wrong before. Do not compute the fee from it, and do not assume "the minimum charge is 100 KES."

Two error messages enforce it, one per amount direction. Note that the first says "at least 100 KES" without the word *net* — it is a net figure regardless:

```
Amount converts to only <n> KES net — M-Pesa onramp requires at least 100 KES. Try a larger amount.
After the fee, only <n> KES converts to USDC — M-Pesa onramp requires at least 100 KES net. Try a larger amount.
```

The gross charged to the customer must also fall inside the supported per-transaction band for KES: **20 to 250,000 KES**. The lower bound is inert — the 100 KES net floor always binds first — so in practice this is a ceiling of 250,000 KES on what one order can charge.

```
Amount converts to <n> KES, outside the supported M-Pesa range of 20–250,000 KES per transaction.
amount_kes must be within the supported M-Pesa range of 20–250,000 KES per transaction.
```

Both are `400`, returned before anything is created and before any phone rings.

### NGN: 1 USDC minimum, 1,000,000 NGN per order

**The floor is 1 USDC out** — the amount your address receives, after the NGN fee is carved out. **The ceiling is 1,000,000 NGN per order** — the gross the customer is asked to transfer, not the USDC you receive. Both are checked before an account is issued, so a request outside either band creates nothing.

On top of the per-order ceiling, two rate limits guard against abuse of the rail itself:

- **5 orders per payer bank account per 10 minutes** — keyed on `refund_account`, across every account on the platform, the same shape as the KES per-phone cap. Retrying the same customer's failed payment repeatedly will run into this.
- **10 order creations per minute per account** — the same cap KES uses, shared between the two currencies rather than doubled.

The practical way to handle either currency's floor: don't precompute a USDC minimum. Call `POST /api/onramp/quote` and let it tell you. The USDC figure that clears either floor moves with the exchange rate.

## Fees

**KES**: a Minisend fee applies to each order, and it is **added on top of the amount that converts to USDC** — the opposite of off-ramp's KES path, where the fee is deducted from what the recipient receives. The customer is charged `amount_local` (the gross), the `fee` portion of it is Minisend's, and the remainder converts to the `amount_usdc` released to your address.

**NGN**: the same shape. `amount_ngn` on the quote and order is the gross the customer transfers, `fee_ngn` (quote) / `fee` (order) is carved out of it, and `net_ngn` / the remainder converts to `amount_usdc`.

The two request directions, on either currency, are just two ways of pinning this down:

- **`amount_usdc`** — you fix what you receive; the customer's charge is grossed up to cover the fee.
- **`amount_kes` / `amount_ngn`** — you fix what the customer is charged; the fee is carved out of it and you receive whatever the remainder converts to.

Whichever you use, read `amount_local` back and show *that* to the customer before they act — before the KES prompt fires, or before you display the NGN account and `payment_instructions.amount`. Never compute the gross yourself from a rate, and never hardcode a fee.

For current rates and fee terms, contact Minisend at `info@minisend.xyz`.

## Failure modes

### KES

Everything that can go wrong after the prompt is sent, and what you observe.

| What the customer does | Order becomes | Event | `failure_reason` |
| --- | --- | --- | --- |
| Declines / cancels the prompt | `cancelled` | `onramp.cancelled` | `stk_failed: <detail>` |
| Has insufficient balance | `failed` | `onramp.failed` | `stk_failed: <detail>` |
| Ignores the prompt until it dies on the handset | `failed`, or `expired` if no failure notice ever arrives | `onramp.failed` or `onramp.expired` | `stk_failed: <detail>`, or none on expiry |
| Never receives a prompt (send failed at creation) | `failed`, immediately | none | `stk_initiation_failed: <detail>` |
| Pays, but confirmation is slow | `pending` until confirmed, then `completed` | `onramp.completed` | — |
| Pays after the window closed | `expired` first, then `completed` when confirmed | `onramp.expired` then `onramp.completed` | — |

Notes that matter in code:

- **A declined prompt and an ignored prompt are not distinguishable to you.** Both land as `failed` with a `stk_failed:` reason whose detail comes from the mobile-money network. Don't branch on the detail text; it isn't a stable enum.
- **`failure_reason` on KES is a diagnostic string, not a code.** Surface it to your own support tooling, not to logic and not verbatim to end users. (NGN's `failure_reason` is different — see below, and see [`failure_reason` values (NGN)](#failure_reason-values-ngn).)
- **The creation-time failure emits no webhook** — the order goes to `failed` before you ever learn its `order_id`. Your only signal is the `502` on the create call.
- **The order window (30 minutes) is much longer than the prompt's life on the handset (a minute or two).** An order sitting `pending` at minute five is not waiting for the customer to act; the prompt is long gone. It is waiting for a confirmation or failure notice that may still arrive. Don't design a UI that tells the customer to keep looking at their phone for the full window.
- **In every failure case, the remedy is a new order.** There is no re-send, no resume, no retry endpoint. Mind the per-phone cap when you retry — five prompts per ten minutes to the same number, counted across all accounts.

### NGN

Unlike KES, NGN's `failure_reason` is a **closed set of stable values**, not free text — see the full table in [`failure_reason` values (NGN)](#failure_reason-values-ngn). The one to design around specifically: **`deposit_not_settled` means the customer already paid.** It is the single case where the correct action is "contact support with the `order_id`," not "create a new order" — asking the customer to transfer again would be asking them to pay twice for one order that already took their money.

Everything else on the NGN failure list — `refunded_to_payer`, `cancelled`, `provision_failed`, `persist_failed`, `price_moved` — resolves the same way a KES failure does: nothing further is owed on that order, and a new order is how the customer tries again.

## Worked example — KES

Collecting KES and receiving USDC, end to end. Runs against the live API with a real `ms_live_` key.

```ts
const BASE = 'https://merchant.minisend.xyz'
const KEY = process.env.MINISEND_API_KEY // ms_live_…
if (!KEY) throw new Error('MINISEND_API_KEY is not set')
const YOUR_WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

const headers = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${body.error ?? JSON.stringify(body)}`)
  return body as T
}

// 1. Quote. amount_kes is what the customer's phone will be prompted for —
//    show them this figure, not net_kes and not a number you computed.
const quote = await call<{
  amount_kes: number
  fee_kes: number
  net_kes: number
  amount_usdc: number
  rate: number
}>('/api/onramp/quote', {
  method: 'POST',
  body: JSON.stringify({ currency: 'KES', amount_usdc: 10 }),
})
console.log(`Customer pays ${quote.amount_kes} KES; you receive ${quote.amount_usdc} USDC`)

// 2. Create the order. THIS RINGS THE PHONE — do it only once the customer
//    has agreed to the amount above. A fresh Idempotency-Key per attempt.
const order = await call<{
  order_id: string
  status: string
  amount_local: number
  amount_usdc: number
  customer_phone: string
  release_address: string
  expires_at: string
  instructions: string
}>('/api/onramp/orders', {
  method: 'POST',
  headers: { 'Idempotency-Key': 'collect-invoice-4471-attempt-1' },
  body: JSON.stringify({
    currency: 'KES',
    amount_usdc: 10,
    phone: '+254712345678', // the PAYING CUSTOMER's number
    address: YOUR_WALLET_ADDRESS, // 0x + 40 hex — the USDC lands here
    reference: 'invoice-4471',
  }),
})
console.log(order.instructions)

// 3. The customer approves the prompt on their handset. Nothing to call.

// 4. Wait for the webhook. Poll only as a fallback, and STOP AT expires_at:
//    A read past the window expires the order in-band, which is fine — that
//    path delivers onramp.expired itself (see "Webhook events").
type OnrampOrderView = {
  status: string
  release_tx_hash: string | null
  failure_reason: string | null
}
const DONE = new Set(['completed', 'failed', 'expired'])
const deadline = new Date(order.expires_at).getTime()

let current = await call<OnrampOrderView>(`/api/onramp/orders/${order.order_id}`)
while (!DONE.has(current.status)) {
  if (Date.now() >= deadline) break // past the window: let the webhook tell you
  await new Promise((r) => setTimeout(r, 5000))
  current = await call<OnrampOrderView>(`/api/onramp/orders/${order.order_id}`)
}
// Note the null checks: on the ORDER object these keys are always present and
// null until set — unlike the webhook payload, which omits them entirely.
console.log(current.status, current.release_tx_hash ?? current.failure_reason)
```

## Worked example — NGN

The same shape, but the customer-facing step is showing them a bank account and a countdown instead of ringing their phone.

```ts
// 1. Create the order. This ISSUES A REAL VIRTUAL ACCOUNT — do it only once
//    the customer has agreed to the amount.
const order = await call<{
  order_id: string
  status: string
  amount_local: number
  amount_usdc: number
  refund_account: { institution: string; account_number: string; account_name: string }
  payment_instructions: {
    bank_name: string
    account_number: string
    account_name: string
    amount: string // STRING — may carry kobo. Show it verbatim.
    currency: string
    expires_at: string
    note: string
  }
  expires_at: string
}>('/api/onramp/orders', {
  method: 'POST',
  headers: { 'Idempotency-Key': 'collect-order-8841-attempt-1' },
  body: JSON.stringify({
    currency: 'NGN',
    amount_ngn: 10120,
    refund_account: {
      institution: 'GTBINGLA', // from GET /api/onramp/institutions?currency=NGN
      account_number: '0123456789',
      account_name: 'John Doe', // usually omit; only send if the bank has no name on file
    },
    address: YOUR_WALLET_ADDRESS,
    reference: 'order-8841',
  }),
})

// 2. Show the customer the account and a countdown against its OWN expiry —
//    not the order's — and never a number you rounded or recomputed.
const { payment_instructions: pi } = order
console.log(
  `Transfer exactly ${pi.amount} ${pi.currency} to ${pi.account_name} · ${pi.bank_name} · ${pi.account_number}`,
)
console.log(`This account stops working at ${pi.expires_at}`)

// 3. Poll or wait for the webhook. deposit_received has no webhook of its
//    own — poll if you want to move the UI off "waiting for transfer" before
//    the order reaches a terminal state.
type NgnOrderView = {
  status: 'pending' | 'deposit_received' | 'completed' | 'failed' | 'expired'
  release_tx_hash: string | null
  failure_reason: string | null
}
let current = await call<NgnOrderView>(`/api/onramp/orders/${order.order_id}`)
if (current.status === 'deposit_received') {
  console.log('Transfer received — stop showing the account, USDC is on its way.')
}
```

Your webhook handler, which is the path you should actually rely on for both rails:

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
    case 'onramp.completed':
      // Cash collected, either rail. event.external_reference is the
      // `reference` you sent. May legitimately arrive AFTER onramp.expired
      // or onramp.failed. event.payment_method tells you which rail —
      // "mpesa" or "bank_transfer" — if your UI needs to differ.
      return markCollected(event.external_reference, event.receipt_number)
    case 'onramp.released':
      // USDC is on-chain at your release_address. Independent of the status
      // transition above — can arrive before OR after onramp.completed.
      return recordRelease(event.order_id, event.release_tx_hash)
    case 'onramp.failed':
      // Declined/timed out (KES) or refunded_to_payer/deposit_not_settled/etc
      // (NGN). Create a NEW order to retry — UNLESS event.failure_reason is
      // "deposit_not_settled", in which case contact support instead; the
      // customer already paid.
      return markFailed(event.external_reference, event.failure_reason)
    case 'onramp.expired':
      // Window closed unpaid. Not guaranteed to arrive — reconcile yourself too.
      return markExpired(event.external_reference)
  }
}
```

## Common mistakes

- **Treating the phone number, or the bank transfer, as a recipient.** In on-ramp the payer is the party being charged, on either rail. Nobody receives local currency. The `address` is the only destination on the order, and it is yours.
- **Sending someone else's wallet address as `address`.** There is no per-order refund path for *your* funds and no recipient validation here. The USDC goes where you say. (`refund_account` on NGN protects the *customer's* naira, not your USDC.)
- **Calling create to "check" something.** Every accepted KES create call rings a real phone and burns one of ten per minute; every accepted NGN create call issues a real bank account and burns the same cap plus the per-`refund_account` cap. Use `POST /api/onramp/quote` for anything exploratory.
- **Building a re-send or resume, on either rail.** There isn't one. A dead prompt or an expired account means a new order.
- **Retrying a `502` with the same `Idempotency-Key`** — `Failed to start the M-Pesa payment` on KES, or `Failed to create the bank transfer account` / `The price moved while creating this order` on NGN. All three return the original failed order and create nothing new. Use a new key.
- **Reading the 100 KES minimum as a minimum charge.** It is a net figure; the customer is always charged more than that. The NGN floor (1 USDC) is not net-vs-gross ambiguous the same way, but it's still worth quoting first rather than assuming.
- **Rounding, reformatting, or recomputing `payment_instructions.amount`.** It's a string for a reason — it can carry kobo, and the customer's transfer has to match it exactly or it isn't credited.
- **Assuming the NGN account is valid for a fixed window.** Read `payment_instructions.expires_at` from the response you got; don't hardcode a duration you observed once.
- **Caching `payment_instructions` past its own expiry, or past the order leaving `pending`.** It disappears from the API response at that point; don't keep showing a stale copy you cached earlier.
- **Treating `deposit_received` as reason to keep showing the bank account.** By the time an order reaches it, the transfer has already landed — showing the account again invites a second, uncredited transfer.
- **Asking the customer to pay again on `deposit_not_settled`.** That specific `failure_reason` means their naira already arrived. Contact support with the `order_id` instead.
- **Assuming `onramp.released` follows `onramp.completed`.** No ordering is guaranteed on either rail, even though the gap tends to be shorter on NGN.
- **Deduplicating webhooks on `order_id` alone.** One order legitimately produces two different events. Key on `order_id` plus `event`.
- **Sealing an order in your own system on `expired` or `failed`.** A late confirmation can still complete it. Handle `onramp.completed` idempotently at any point.
- **Assuming on-ramp supports the off-ramp currencies.** It's KES and NGN only, not GHS or UGX.
- **Sending `network: "mpesa"` or `"safaricom"` on a KES order.** Only the exact string `Safaricom` is honoured (`Airtel` is refused); anything else is ignored without an error. Omit the field and let it auto-detect.
- **Looking for `reference` in the response.** You send `reference`; you get back `external_reference`.
- **Polling for `deposit_received` and treating a miss as failure.** There's no webhook for it, so absence just means you haven't polled recently enough, not that the transfer failed.
