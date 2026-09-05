# Off-ramp

## What it does

Off-ramp turns USDC into local currency in someone else's hands. You quote an amount, create an order naming a recipient, send USDC on Base, and Minisend delivers KES, NGN, GHS, or UGX to that recipient's phone, till, paybill, or bank account. The recipient is set per order, so each order can pay a different person — this is a payout API, not a settlement of your own balance to your own account. You send the USDC yourself, from your own wallet, using whatever tooling you already have.

Base URL: `https://merchant.minisend.xyz`

## Requirements

- An `ms_live_` API key carrying the `offramp` scope.
- The off-ramp capability enabled on your account.

Both gates must pass, and both fail with the identical 403 — you cannot tell from the response which one is missing, and you must not build logic that tries. Read `references/authentication.md` before writing request code; it covers the key format, the 403 model, and rate limits.

If off-ramp is switched off platform-wide, every endpoint here returns `503 { "error": "Off-ramp API is not available." }`.

**Rate limits.** The general limit is applied per calling client (by IP), not per key. On top of it, two off-ramp endpoints carry their own **per-account** cap: creating an order is 20 per minute, and submitting a deposit is 20 per minute. Each returns its own 429 message. See `references/authentication.md`.

## The flow

1. **Quote** — `POST /api/offramp/quote`. Get the rate and, more importantly, `recipient_amount`: the pre-send figure to show your user, being what the recipient nets *at the quoted rate*. It is not the settled figure — see [Which figure to show, and when](#which-figure-to-show-and-when).
2. **Validate the account** (optional but recommended) — `POST /api/offramp/validate-account`. Resolves the recipient's registered name so you can confirm it with your user before money moves.
3. **Create the order** — `POST /api/offramp/orders`. Returns `deposit_address`, `total_deposit_usdc`, `expires_at`, and a human-readable `instructions` string.
4. **Send USDC on Base** from your own wallet to `deposit_address`, for exactly `total_deposit_usdc`.
5. **Submit the transaction hash** — `POST /api/offramp/orders/{order_id}/deposit`. **Required for KES, GHS, and UGX. Not used for NGN.** See below.
6. **Receive the webhook** — `offramp.completed`, `offramp.failed`, or `offramp.expired` at your configured webhook URL. Or poll `GET /api/offramp/orders/{order_id}`.

## The two deposit paths

This is the one thing that most often breaks an off-ramp integration. **Which path you're on is decided by the payout currency, and the two behave differently after you send the USDC.**

| | KES, GHS, UGX | NGN |
| --- | --- | --- |
| `deposit_address` | A shared address, reused across orders | A single-use address, unique to this order |
| Amount to send | `total_deposit_usdc` (equals `amount_usdc`) | `total_deposit_usdc` (`amount_usdc` plus deposit-side fees — **larger** than `amount_usdc`) |
| After you send | **You must submit the transaction hash** to `POST /api/offramp/orders/{order_id}/deposit` | Nothing. The deposit is detected automatically |
| If you skip step 5 | Nothing happens. The order expires unpaid | N/A — there is no step 5 |
| Order moves to `settling` | When your submitted hash is accepted | When the deposit is detected |

Your code has to branch on this. The safest branch key is the payout currency you already know — NGN on one side, KES/GHS/UGX on the other — and the order response corroborates it: only an NGN order carries `sender_fee_usdc` and `transaction_fee_usdc`, and the `instructions` string spells out which of the two procedures applies.

### Path A — KES, GHS, UGX: send, then submit the hash

Because `deposit_address` is shared across orders, Minisend cannot tell your transfer apart from anyone else's. Your submitted transaction hash is what ties the transfer to your order. Until you submit it, nothing at all happens.

```
create order → send exactly amount_usdc USDC (Base) to deposit_address
             → POST /api/offramp/orders/{order_id}/deposit { "transaction_hash": "0x…" }
             → status becomes settling → webhook
```

The `instructions` string returned on creation says exactly this, with your order's own values substituted:

> Send exactly `<amount_usdc>` USDC (Base) to deposit_address from your own wallet, then submit the transaction hash via POST /api/offramp/orders/`<order_id>`/deposit before expires_at.

### Path B — NGN: send and wait

`deposit_address` is minted for this order alone and is watched for you. Sending the USDC is the whole job.

```
create order → send exactly total_deposit_usdc USDC (Base) to deposit_address
             → deposit detected → status becomes settling → webhook
```

`total_deposit_usdc` on this path is **larger** than `amount_usdc` — it includes the deposit-side fees returned as `sender_fee_usdc` and `transaction_fee_usdc`. Send `amount_usdc` and the order will not fund correctly. Always send `total_deposit_usdc`.

The `instructions` string on this path reads:

> Send exactly `<total_deposit_usdc>` USDC (Base) — the order amount plus network fees — to deposit_address before expires_at. The deposit is detected automatically; no further action needed.

Calling the deposit endpoint on an NGN order is rejected:

```json
{ "error": "This order settles automatically once funds arrive at deposit_address. No hash submission needed for this currency." }
```

## Endpoint reference

> **About the numbers in the sample responses below.** Every priced field — `rate`, `amount_local`, `fee`, `recipient_amount`, `total_deposit_usdc`, `sender_fee_usdc`, `transaction_fee_usdc` — is shown as `0`. That is a placeholder, not a value. Read the real figures from the live response; never hardcode them and never derive one from another.

All requests use `Content-Type: application/json` and `Authorization: Bearer ms_live_…`.

### `POST /api/offramp/quote`

Prices an off-ramp without creating anything. Nothing is reserved and no funds move.

Request:

```json
{
  "amount": 25,
  "currency": "KES",
  "recipient": {
    "account_name": "Jane Wanjiru",
    "method": "MOBILE",
    "phone": "+254712345678",
    "mobile_network": "Safaricom"
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `amount` | yes | Number, USDC. Must be positive and finite. Rounded to 2 decimal places. |
| `currency` | yes | `KES`, `GHS`, `NGN`, or `UGX`. Upper-cased for you. |
| `recipient` | no | Include it and the recipient is validated too, returning `recipient_name`. Shape in `references/recipients.md`. |

Response `200`:

```json
{
  "amount_usdc": 25,
  "currency": "KES",
  "rate": 0,
  "amount_local": 0,
  "fee": 0,
  "recipient_amount": 0,
  "recipient_name": "JANE WANJIRU",
  "expires_at": "2026-07-31T10:35:00.000Z"
}
```

- `amount_local` is the gross local amount the USDC converts to.
- `fee` is the Minisend fee, in local currency units.
- **`recipient_amount` is the figure to show your user before they commit.** It is what the recipient nets at the quoted rate. It is a quote, not a settled figure — see [Which figure to show, and when](#which-figure-to-show-and-when).
- `recipient_name` is present only when you supplied a `recipient` *and* a registered name could be resolved.
- `expires_at` is 5 minutes out. It is informational — the quote endpoint reserves nothing, and the order you create later is priced fresh.

Errors: `400 { "error": "Invalid JSON body." }` if the body isn't valid JSON; `400` for a bad amount, currency, or recipient (messages in `references/recipients.md`); `422` if the supplied recipient fails a hard validation gate; `502 { "error": "Failed to generate quote." }` if pricing is unavailable.

### `POST /api/offramp/validate-account`

Resolves the recipient's registered name. No amount involved.

Request:

```json
{
  "currency": "NGN",
  "recipient": {
    "account_name": "Chidi Okafor",
    "institution": "GTBINGLA",
    "account_number": "0123456789"
  }
}
```

Response `200`:

```json
{ "valid": true, "recipient_name": "CHIDI OKAFOR" }
```

`recipient_name` is `null` when the destination is valid but no name is available.

Response `422`:

```json
{ "valid": false, "error": "Recipient validation failed. Confirm the account details and try again." }
```

A body that isn't valid JSON returns `400 { "error": "Invalid JSON body." }`; a missing or unsupported `currency`, or a malformed `recipient`, returns `400` with the messages in `references/recipients.md`.

Whether a failure here would actually block an order depends on the destination — bank destinations are hard-gated, mobile/till/paybill lookups are best-effort and never block. `references/recipients.md` has the full table; read it before you decide to treat this endpoint's result as authoritative.

### `GET /api/offramp/institutions`

**Requires an `ms_live_` key with the `offramp` scope.** Lists the banks and mobile money providers an NGN recipient can hold, with the code each one is identified by.

`recipient.institution` on an NGN order is an opaque code with no way to guess it, and a wrong code fails the order. Read the list rather than hardcoding one.

Query:

| Parameter | Required | Notes |
| --- | --- | --- |
| `currency` | no | Defaults to `NGN`, which is currently the only accepted value. |

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

The response carries `Cache-Control: private, max-age=3600`. The list is near-static and identical for every caller, so cache it rather than calling this before every order.

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "error": "No institution list for KES. Only NGN identifies a recipient by institution code; other currencies use recipient.method with a phone number." }` | A currency that does not use institution codes. **This is not a gap to work around** — KES, GHS, and UGX recipients are identified by `method` plus a phone number, and no list exists for them. |
| `502` | `{ "error": "Could not load the institution list. Try again shortly." }` | Upstream lookup failed. Retry. |
| `503` | `{ "error": "Off-ramp API is not available." }` | Off-ramp is switched off for the deployment. |
| `401` / `403` | See `references/authentication.md`. | Key missing, invalid, or without the `offramp` scope. |

### `POST /api/offramp/orders`

Creates the order and tells you where to send USDC.

Optional header: `Idempotency-Key: <your-unique-string>`. A replay with the same key returns the original order with status `200` instead of creating a second one. Use it — order creation triggers real downstream work.

Request:

```json
{
  "amount": 25,
  "currency": "KES",
  "refund_address": "0x1234567890abcdef1234567890abcdef12345678",
  "reference": "invoice-4471",
  "recipient": {
    "account_name": "Jane Wanjiru",
    "method": "MOBILE",
    "phone": "+254712345678",
    "mobile_network": "Safaricom"
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `amount` | yes | Number, USDC. |
| `currency` | yes | `KES`, `GHS`, `NGN`, `UGX`. |
| `refund_address` | yes | Your own address, `0x` + 40 hex characters. Where funds return if the payout can't complete. |
| `reference` | no | Your own identifier. **Note the asymmetry: you send `reference`, and it comes back as `external_reference`** on the order and on the webhook. |
| `recipient` | yes | See `references/recipients.md`. |

Response `201`:

```json
{
  "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
  "status": "pending",
  "amount_usdc": 25,
  "total_deposit_usdc": 0,
  "currency": "KES",
  "rate": 0,
  "amount_local": 0,
  "fee": 0,
  "recipient_amount": 0,
  "deposit_address": "0x…",
  "deposit_chain": "base",
  "recipient": {
    "account_name": "Jane Wanjiru",
    "method": "MOBILE",
    "phone": "0712345678"
  },
  "refund_address": "0x1234567890abcdef1234567890abcdef12345678",
  "external_reference": "invoice-4471",
  "expires_at": "2026-07-31T11:00:00.000Z",
  "created_at": "2026-07-31T10:30:00.000Z",
  "instructions": "Send exactly 25 USDC (Base) to deposit_address from your own wallet, then submit the transaction hash via POST /api/offramp/orders/8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30/deposit before expires_at."
}
```

An NGN order carries two extra fields, `sender_fee_usdc` and `transaction_fee_usdc`, and its `total_deposit_usdc` is `amount_usdc` plus those two. On the KES/GHS/UGX path `total_deposit_usdc` equals `amount_usdc`.

Fields that only populate once the order progresses: `deposit_tx_hash`, `settlement_receipt`, `completed_at`. **On the order object these keys are always present and carry `null` until they are set** — they are not omitted. Test them for truthiness or for `null`; `=== undefined` and `'settlement_receipt' in order` both give the wrong answer here. The exceptions are `sender_fee_usdc` and `transaction_fee_usdc`, which really are absent on a non-NGN order.

**This differs from the webhook payload**, where optional fields *are* dropped entirely when unset. The two surfaces genuinely behave differently, so a null-check that works on one will not work on the other.

`deposit_chain` is also conditional, and this one catches people: it is set to `"base"` on KES, GHS, and UGX orders, but **an NGN order never sets it, so it comes back as `null`**. Both paths take USDC on Base regardless — branch on the payout currency, not on `deposit_chain`.

Key rules:

- **`deposit_address` is authoritative per order. Read it from the response every time. Never cache it, never hardcode it** — on the NGN path it is unique to the order, and on the other path it may change.
- `expires_at` is your deposit window: 30 minutes from creation on the KES/GHS/UGX path, and on the NGN path whatever validity the single-use deposit address carries, which may be shorter. Read it from the response rather than assuming 30 minutes. Depositing after it has passed will not settle the order.
- `recipient_amount` is returned on creation but is not part of the stored order — capture it here if you need to display it later.

Errors: `400 { "error": "Invalid JSON body." }`; `400` validation (see `references/recipients.md`); `422 { "error": "Recipient validation failed. Confirm the account details and try again." }` — no order is created; `429` creation limit; `502 { "error": "Failed to price the order." }`; `502 { "error": "Failed to provision deposit address. Retry with a new Idempotency-Key." }` — note the *new* key, since the failed order id is now spent; `500 { "error": "Failed to create order." }`.

An out-of-range conversion returns `400` before anything is created, naming the band in both local currency and the USDC equivalent at the current rate:

```
Amount converts to <local amount> <CURRENCY>, outside the supported range of
<min>–<max> <CURRENCY> per transaction (≈ <min>–<max> USDC at the current rate).
```

### `POST /api/offramp/orders/{order_id}/deposit`

KES, GHS, and UGX only. Reports the transfer you already made so the payout can be released.

Request:

```json
{ "transaction_hash": "0xabc…" }
```

`transaction_hash` must be `0x` followed by exactly 64 hex characters — the Base transaction in which you sent the order's USDC to `deposit_address`.

Response `200`: the full order object (same shape as creation, minus `instructions` and `recipient_amount`), now with `status: "settling"` and `deposit_tx_hash` set.

Errors:

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "error": "transaction_hash must be a 0x-prefixed 32-byte hex hash." }` | Malformed hash. |
| `400` | `{ "error": "Invalid JSON body." }` | Body wasn't valid JSON. |
| `404` | `{ "error": "Order not found." }` | Unknown order, or one belonging to another account — the same 404 either way. |
| `409` | `{ "error": "This order settles automatically once funds arrive at deposit_address. No hash submission needed for this currency." }` | NGN order. |
| `409` | `{ "error": "Order is <status> and can no longer be paid." }` | Order is in a state past `pending` — the live status name is interpolated into the message. |
| `409` | `{ "error": "Order expired before a deposit was submitted. Create a new order." }` | The deposit window closed. The order is flipped to `expired`. |
| `409` | `{ "error": "This transaction hash was already used for another order." }` | One transfer cannot pay two orders. |
| `422` | `{ "error": "Payment verification failed: <detail>. Confirm the hash, amount, and chain, then retry." }` | The transfer didn't check out — wrong amount, wrong chain, wrong destination, or otherwise not accepted. `<detail>` carries the specific reason. **Retryable:** the order stays `pending` and you may submit a corrected hash. |
| `429` | Deposit submission limit. | 20 per minute, per account. |

Two behaviours worth relying on:

- **Safe to retry after a 422.** The claim on the order is released, so a corrected hash goes through.
- **Safe to replay.** Submitting again on an order already `settling` or `completed` returns `200` with the current order and does not pay twice. Concurrent submissions of the same order resolve to a single payout.

### `GET /api/offramp/orders/{order_id}`

Response `200`: the order object, same shape as the creation response minus `instructions` and `recipient_amount`.

Reading a `pending` order whose `expires_at` has passed flips it to `expired` and returns the expired order.

`404 { "error": "Order not found." }` for an unknown order *and* for one owned by another account — you cannot distinguish them, by design.

### `GET /api/offramp/orders`

Lists your orders, newest first by creation time.

Query parameters:

| Parameter | Default | Notes |
| --- | --- | --- |
| `status` | — | Filter by one status string. |
| `limit` | `20` | Capped at 100. |
| `offset` | `0` | Negative values are clamped to 0. |

Response `200`:

```json
{
  "orders": [
    {
      "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
      "status": "completed",
      "amount_usdc": 25,
      "total_deposit_usdc": 0,
      "currency": "KES",
      "rate": 0,
      "amount_local": 0,
      "fee": 0,
      "deposit_address": "0x…",
      "deposit_chain": "base",
      "deposit_tx_hash": "0xabc…",
      "recipient": {
        "account_name": "Jane Wanjiru",
        "method": "MOBILE",
        "phone": "0712345678"
      },
      "refund_address": "0x1234567890abcdef1234567890abcdef12345678",
      "external_reference": "invoice-4471",
      "settlement_receipt": "SLJ7K2P9QX",
      "expires_at": "2026-07-31T11:00:00.000Z",
      "completed_at": "2026-07-31T10:34:12.000Z",
      "created_at": "2026-07-31T10:30:00.000Z"
    }
  ],
  "total": 137,
  "limit": 20,
  "offset": 0
}
```

Each element is a **complete order object** — the same shape `GET /api/offramp/orders/{order_id}` returns. You do not need to follow up with a per-order fetch.

`total` is the count of all matching orders, not the page — paginate with `offset` until `offset + limit >= total`.

## Order lifecycle

The complete status vocabulary. These exact strings appear on the order, in the `status` query parameter, and on the webhook payload.

| Status | Meaning | Final? |
| --- | --- | --- |
| `pending` | Order created, awaiting your USDC. On the KES/GHS/UGX path it stays here until you submit the hash. | no |
| `deposit_received` | Part of the defined vocabulary but not emitted by the current flows, which go straight from `pending` to `settling`. Handle it as non-final if you ever see it; don't build a step around it. | no |
| `settling` | Deposit accounted for; the local-currency payout is in flight. | no |
| `completed` | The recipient was paid. `completed_at` and usually `settlement_receipt` are set. | **yes** |
| `failed` | The payout did not succeed. | **yes** |
| `expired` | The deposit window closed with no accepted deposit. | **yes** |

`completed`, `failed`, and `expired` are terminal and immutable — an order never leaves them, and repeated settlement notifications about a terminal order are ignored. Treat any other status as still moving.

`settlement_receipt` on a completed order is the payout's receipt reference: a settlement transaction hash on the NGN path, and the local-currency payment receipt number on the KES/GHS/UGX path.

## Webhook events

Off-ramp emits exactly three events to your configured webhook URL:

| Event | Fires when |
| --- | --- |
| `offramp.completed` | Order reached `completed`. |
| `offramp.failed` | Order reached `failed`. |
| `offramp.expired` | Order reached `expired` — the deposit window passed unfunded. |

There is no event for `settling`, and none for order creation. Every off-ramp event corresponds to a terminal state, so an order produces at most one *distinct* off-ramp event — but a delivery that your endpoint doesn't acknowledge with a 2xx is retried, so the same event can arrive more than once. Make your handler idempotent on `order_id`.

`offramp.expired` is delivered whichever way an unfunded order expires: the background sweep, or an API call that observes a still-`pending` order past its `expires_at` and expires it in-band. Two calls do the latter:

- `GET /api/offramp/orders/{order_id}` — returns the now-`expired` order.
- `POST /api/offramp/orders/{order_id}/deposit` — a late hash submission expires the order and returns `409 { "error": "Order expired before a deposit was submitted. Create a new order." }`.

Earlier versions delivered nothing on either of those paths, because the in-band flip put the order out of reach of the sweep — so polling an order past its window cost you its expiry event. Both paths deliver now, and the status flip is atomic, so you get the event exactly once.

Delivery is retried but not guaranteed, so reconciling your own `pending` orders once their `expires_at` has passed is still worth doing. Treat that 409 and an `expired` status on a read as terminal in their own right.

Payload:

```json
{
  "event": "offramp.completed",
  "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
  "external_reference": "invoice-4471",
  "status": "completed",
  "amount_usdc": 25,
  "amount_local": 0,
  "payout_currency": "KES",
  "exchange_rate": 0,
  "fee": 0,
  "recipient_account_name": "Jane Wanjiru",
  "settlement_receipt": "SLJ7K2P9QX",
  "completed_at": "2026-07-31T10:34:12.000Z",
  "created_at": "2026-07-31T10:30:00.000Z"
}
```

The priced fields above (`amount_local`, `exchange_rate`, `fee`) are shown as `0` for the same reason as in the endpoint reference — they are placeholders, not values. On a real payload they carry the settled economics.

Note the field names differ from the order object: `payout_currency` (not `currency`) and `exchange_rate` (not `rate`). **Optional fields are omitted from the webhook payload when unset** — the opposite of the order object, which keeps the key and sets it to `null`. Write your webhook checks against a missing key, and your order-object checks against `null`.

Signed with HMAC-SHA256 over the raw request body using your webhook secret, in the `X-Minisend-Signature` header (lower-case hex). The header is only attached when a webhook secret is configured on your account — if none is set, deliveries arrive unsigned, so treat a missing signature as a configuration problem to fix rather than something to skip verification for. Verify against the raw bytes, not a re-serialized parse. Full delivery, retry, and verification detail is in `references/webhooks.md`.

## Limits

**USDC per order:** 0.5 minimum, 50,000 maximum.

```json
{ "error": "Amount below minimum of 0.5 USDC." }
{ "error": "Amount exceeds maximum of 50000 USDC." }
```

**Local currency per transaction** — the supported band for the converted amount:

| Currency | Minimum | Maximum | Rejected pre-order if outside? |
| --- | --- | --- | --- |
| KES | 20 | 250,000 | yes |
| GHS | 5 | 5,000 | yes |
| UGX | 500 | 5,000,000 | yes |
| NGN | 100 | 1,000,000 | no pre-order check runs — stay inside the band anyway |

Because these bands are in local currency and the exchange rate moves, the USDC amount that satisfies them moves too. Don't precompute the USDC bounds — quote first. For KES, GHS, and UGX, a conversion outside the band is rejected with the `400` shown above before any order exists. NGN gets no such pre-order rejection, so an out-of-band NGN amount can reach order creation and fail later instead — check it yourself.

## Fees

A Minisend fee applies to each off-ramp order. On the KES, GHS, and UGX path it is **deducted from the local amount**, so the recipient receives less than the gross conversion — `amount_local` is the gross, `fee` is the deduction, and `recipient_amount` is what lands. On the NGN path there is no separate line-item deduction; the pricing is carried in the rate, and `recipient_amount` equals `amount_local`.

The NGN path additionally has deposit-side fees, returned on the order as `sender_fee_usdc` and `transaction_fee_usdc`. These are added to what you send, not taken from the recipient: `total_deposit_usdc` already includes them, which is why it exceeds `amount_usdc`.

### Which figure to show, and when

There are two moments, and they need different fields.

**Before you send — `recipient_amount`.** It is the authoritative figure to quote to your user at decision time, from either the quote response or the order-creation response. Never compute it yourself from a rate and never hardcode a fee.

**After settlement — `amount_local` and `fee` on the terminal webhook.** On the KES, GHS, and UGX path the order is priced again at the moment the payout is released, so the executed economics can differ from the quote: `amount_local`, `exchange_rate`, and `fee` on the `offramp.completed` payload are the settled values, not the ones you saw at creation. **`amount_local` minus `fee` is what the recipient actually received.** `recipient_amount` is not stored on the order and is not in the webhook payload, so this subtraction is the only route to the final number — record it from the webhook rather than reusing your quote-time figure for receipts, reconciliation, or accounting.

On the NGN path `fee` is not a deduction and `amount_local` is the recipient's amount directly.

For current rates and fee terms, contact Minisend at `info@minisend.xyz`.

## Worked example

A KES payout end to end, including the hash-submission step. Runs against the live API with a real `ms_live_` key.

```ts
const BASE = 'https://merchant.minisend.xyz'
const KEY = process.env.MINISEND_API_KEY // ms_live_…
if (!KEY) throw new Error('MINISEND_API_KEY is not set')

const headers = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
}

const recipient = {
  account_name: 'Jane Wanjiru',
  method: 'MOBILE',
  phone: '+254712345678',
  mobile_network: 'Safaricom',
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

// 1. Quote. recipient_amount is the figure to SHOW Jane before she commits —
//    not amount_local. It is quote-time, not settled: reconcile afterwards
//    from amount_local minus fee on the offramp.completed webhook.
const quote = await call<{
  rate: number
  amount_local: number
  fee: number
  recipient_amount: number
  recipient_name?: string
}>('/api/offramp/quote', {
  method: 'POST',
  body: JSON.stringify({ amount: 25, currency: 'KES', recipient }),
})
console.log(`Jane receives about ${quote.recipient_amount} KES`, quote.recipient_name)

// 2. Create the order. Idempotency-Key makes a retry safe.
const order = await call<{
  order_id: string
  status: string
  deposit_address: string
  total_deposit_usdc: number
  expires_at: string
  instructions: string
}>('/api/offramp/orders', {
  method: 'POST',
  headers: { 'Idempotency-Key': 'payout-invoice-4471' },
  body: JSON.stringify({
    amount: 25,
    currency: 'KES',
    refund_address: '0x1234567890abcdef1234567890abcdef12345678',
    reference: 'invoice-4471',
    recipient,
  }),
})

// 3. Send USDC on Base to order.deposit_address, for exactly
//    order.total_deposit_usdc, from your own wallet — with viem, ethers,
//    or whatever you already use. Must land before order.expires_at.
const txHash = await sendUsdcOnBase(order.deposit_address, order.total_deposit_usdc)

// 4. KES is on the hash-submission path: report the transfer.
//    (Skip this entire step for NGN — its deposit is detected automatically.)
await call(`/api/offramp/orders/${order.order_id}/deposit`, {
  method: 'POST',
  body: JSON.stringify({ transaction_hash: txHash }),
})

// 5. Wait for the webhook. Poll only as a fallback. A read past the window
//    expires the order in-band, which is fine — that path delivers
//    offramp.expired itself (see "Webhook events").
// settlement_receipt is `null` until set on the order object — not absent.
type OfframpOrderView = { status: string; settlement_receipt: string | null }
const FINAL = new Set(['completed', 'failed', 'expired'])
const deadline = new Date(order.expires_at).getTime()

let current = await call<OfframpOrderView>(`/api/offramp/orders/${order.order_id}`)
while (!FINAL.has(current.status)) {
  if (Date.now() >= deadline) break // past the window: let the webhook tell you
  await new Promise((r) => setTimeout(r, 5000))
  current = await call<OfframpOrderView>(`/api/offramp/orders/${order.order_id}`)
}
console.log(current.status, current.settlement_receipt)
```

Your webhook handler, which is the path you should actually rely on:

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
    case 'offramp.completed':
      // event.external_reference is the `reference` you sent at creation.
      return markPaid(event.external_reference, event.settlement_receipt)
    case 'offramp.failed':
      return markFailed(event.external_reference)
    case 'offramp.expired':
      // You never funded it in time. Create a new order if still needed.
      return markExpired(event.external_reference)
  }
}
```

## Common mistakes

- **Sending USDC and stopping there, on a KES/GHS/UGX order.** No hash, no payout. The order expires.
- **Sending `amount_usdc` instead of `total_deposit_usdc` on an NGN order.** It's short by the deposit-side fees.
- **Caching `deposit_address`.** On the NGN path it is single-use per order; reusing one is a lost transfer.
- **Displaying `amount_local` as what the recipient gets, pre-send.** That's the gross. Quote with `recipient_amount`.
- **Reconciling against the quote-time `recipient_amount`.** The KES/GHS/UGX path re-prices at payout, so the settled figure is `amount_local` minus `fee` on the terminal webhook.
- **Branching on `deposit_chain`.** It is `null` on NGN orders — present, not absent — even though the deposit still goes to Base. Branch on the payout currency.
- **Looking for `reference` in the response.** You send `reference`; you get back `external_reference`.
- **Treating a successful order creation as proof a phone number exists.** For mobile, till, and paybill destinations validation is best-effort and never blocks — see `references/recipients.md`.
- **Omitting `refund_address`.** It is required on every order, and it is where funds return if the payout can't complete.
