# On-ramp

## What it does

On-ramp is the inbound half of Minisend: you collect local currency from a paying customer and receive USDC at a wallet address you nominate. You create an order naming the customer's phone number and your own release address; Minisend sends an M-Pesa payment prompt to that phone; when the customer approves it on their handset, USDC is released on Base to your address.

The customer — the **payer** — is the party being charged. You — the **integrator** — are the party receiving value. The address on the order is yours, not theirs.

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

**Rate limits.** The general limit is applied per calling client (by IP), not per key. On top of it, on-ramp carries two of its own:

| Cap | Scope | Limit | Message on 429 |
| --- | --- | --- | --- |
| Order creation | Per account | 10 per minute | `Too many onramp orders created recently. Please slow down, or contact info@minisend.xyz if you need a higher limit.` |
| Payment prompts to one phone | Per phone number, across **all** accounts | 5 per 10 minutes | `Too many payment requests sent to this phone number recently. Please wait before retrying.` |

The order-creation cap is the strictest of Minisend's three creation caps, because every accepted call rings a real phone. The per-phone cap is not yours to spend — another integrator's traffic to the same number counts against it, and so do your own retries. The account cap is consumed by *every* create call, including calls that replay an `Idempotency-Key` and create nothing.

## The flow

1. **Quote** (optional) — `POST /api/onramp/quote`. Prices the collection so you can show the customer what they will be charged. Nothing is created and no prompt is sent.
2. **Create the order** — `POST /api/onramp/orders`. This **immediately sends the payment prompt to the customer's phone**. The order comes back `pending`.
3. **The customer approves the prompt on their handset** and enters their PIN. You have no API control over this step.
4. **Minisend releases USDC on Base** to your `release_address`.
5. **Receive the webhooks** — `onramp.completed` when the cash is collected, `onramp.released` when the on-chain transfer is recorded. Or poll `GET /api/onramp/orders/{order_id}`.

**The prompt is one-shot.** It fires once, at creation, and there is no endpoint to re-send it. If the customer declines it, ignores it, or it dies of old age, the order ends `failed` or `expired` and stays that way — you create a **new order** to try again. This is deliberate: it makes it structurally impossible for one order to charge a customer twice.

## Endpoint reference

> **About the numbers in the sample responses below.** Every priced field — `rate`, `amount_kes`, `fee_kes`, `net_kes`, `amount_local`, `fee` — is shown as `0`. That is a placeholder, not a value. Read the real figures from the live response; never hardcode them and never derive one from another.

All requests use `Content-Type: application/json` and `Authorization: Bearer ms_live_…`.

### `POST /api/onramp/quote`

Prices a collection without creating anything. **No payment prompt is sent.** Nothing is reserved.

Request — `currency` plus exactly one of `amount_usdc` or `amount_kes`:

```json
{ "currency": "KES", "amount_usdc": 10 }
```

| Field | Required | Notes |
| --- | --- | --- |
| `currency` | no | `KES` only. Upper-cased for you. Omitted or non-string defaults to `KES`; any other value is rejected. |
| `amount_usdc` | one of | The **net USDC you want to receive**. The customer is charged the grossed-up local amount. Positive finite number, rounded to 2 decimal places. |
| `amount_kes` | one of | The **exact KES the customer will be charged**. The fee is carved out of it and the remainder converts to USDC. Positive finite number, rounded to a whole number. |

Send both, or neither, and you get `400 { "error": "Provide exactly one of amount_usdc or amount_kes (positive number)." }`. The two directions are the same arithmetic read from opposite ends — pick whichever end your product fixes.

Response `200`:

```json
{
  "currency": "KES",
  "amount_kes": 0,
  "fee_kes": 0,
  "net_kes": 0,
  "amount_usdc": 10,
  "rate": 0,
  "expires_at": "2026-07-31T10:35:00.000Z"
}
```

- **`amount_kes` is what the customer's phone will be prompted for.** This is the figure to show them. It is the gross: `net_kes` plus `fee_kes`.
- `net_kes` is the portion that converts to USDC.
- **`amount_usdc` is what your address receives.**
- `expires_at` is 5 minutes out and is informational only. The quote reserves nothing, and order creation re-prices from scratch — so the amounts on the order can differ from the ones you quoted. Read them back from the order response.

Errors: `400 { "error": "Invalid JSON body." }`; `400 { "error": "Only KES (M-Pesa) onramp is supported." }`; `400` for the amount rules above or an out-of-band amount (see [Limits](#limits)); `502 { "error": "Failed to generate quote." }` if pricing is unavailable.

### `POST /api/onramp/orders`

Creates the order **and sends the payment prompt in the same call.** A `201` here means a real phone is ringing.

Optional header: `Idempotency-Key: <your-unique-string>`. A replay with the same key returns the original order with status `200` and does **not** send a second prompt. Use it — see the warning below about what a replay returns after a failure.

Request:

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
| `currency` | no | `KES` only; defaults to `KES`. |
| `amount_usdc` / `amount_kes` | one of | Exactly one, same rules as the quote. The order is priced server-side; client-supplied prices are never trusted. |
| `phone` | yes | The **paying customer's** Kenyan mobile number. Accepted input shapes are the same as off-ramp's — see `references/recipients.md`. Normalised to `0XXXXXXXXX`. |
| `network` | no | `Safaricom` or `Airtel`, overriding auto-detection. See the note below — this field is fussier than it looks. |
| `address` | yes | **Your own** wallet address, `0x` + 40 hex characters. Where the USDC is released, on Base. Lower-cased on the order. |
| `reference` | no | Your own identifier. **Note the asymmetry: you send `reference`, and it comes back as `external_reference`** on the order and on the webhook. |

There is no `refund_address` on an on-ramp order and no recipient object — nothing is paid out in local currency, so neither applies.

**The `network` field behaves differently from off-ramp's `mobile_network`.** Off-ramp normalises forgivingly (`references/recipients.md` documents the aliases and case-folding). Here, only the exact strings `Safaricom` and `Airtel` are honoured; anything else — `safaricom`, `mpesa`, `SAFARICOM` — is **silently ignored** rather than rejected, and the carrier is auto-detected from the number's prefix instead. Auto-detection is the better path: leave `network` out unless you have a specific reason. And note that an explicit override *replaces* the carrier check entirely, so overriding a number that isn't on that network produces an order that fails when the prompt is sent rather than a clean `400`.

Response `201`:

```json
{
  "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
  "status": "pending",
  "currency": "KES",
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
- `release_chain` is `base` and `release_asset` is `USDC` on every order today.
- `expires_at` is 30 minutes from creation. The prompt itself dies on the handset much sooner (a minute or two); the longer window covers slow confirmations before the order is swept to `expired`.
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
| `400` | `{ "error": "Only Safaricom and Airtel numbers are supported." }` | A real Kenyan number on a carrier with no mobile-money route. |
| `400` | `{ "error": "Only KES (M-Pesa) onramp is supported." }` | `currency` was something other than `KES`. |
| `400` | `{ "error": "Provide exactly one of amount_usdc or amount_kes (positive number)." }` | Both amounts, neither, or a non-positive one. |
| `400` | Amount messages in [Limits](#limits). | Below the minimum, or outside the supported band. |
| `429` | Creation or per-phone cap. | See [Requirements](#requirements). |
| `502` | `{ "error": "Failed to price the order." }` | Pricing unavailable. Nothing created. |
| `500` | `{ "error": "Failed to create order." }` | Order could not be recorded. Nothing created. |
| `502` | `{ "error": "Failed to start the M-Pesa payment: <detail>. Create a new order to retry." }` | The order **was** created and is now `failed`. No prompt reached the customer. |

**That last one deserves care.** The order exists, it is `failed`, and the response body carries no `order_id` — so you have no handle on it. Worse, if you retry with the **same** `Idempotency-Key`, you get `200` and that same `failed` order back, and no prompt is sent. Retry with a **new** `Idempotency-Key`, exactly as the message says.

### `GET /api/onramp/orders/{order_id}`

Response `200`: the order object, same shape as the creation response minus `instructions`.

Reading a `pending` order whose `expires_at` has passed flips it to `expired` and returns the expired order — with a consequence for webhooks, described in [Webhook events](#webhook-events).

`404 { "error": "Order not found." }` for an unknown order *and* for one owned by another account — you cannot distinguish them, by design.

### `GET /api/onramp/orders`

Lists your orders, newest first by creation time.

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

Each element is a **complete order object** — the same shape the single-order endpoint returns. No follow-up fetch needed.

`total` is the count of all matching orders, not the page — paginate with `offset` until `offset + limit >= total`.

Unlike the single-order read, listing does **not** expire stale `pending` orders.

## Order lifecycle

The complete status vocabulary. These exact strings appear on the order, in the `status` query parameter, and on the webhook payload.

| Status | Meaning | Final? |
| --- | --- | --- |
| `pending` | Order created, prompt sent, waiting on the customer. | no |
| `completed` | The local currency was collected. `completed_at` is set, and `receipt_number` carries the customer's payment receipt. | **yes** |
| `failed` | The prompt did not result in a payment — declined, timed out, insufficient balance — or the prompt could not be sent at all. `failure_reason` is set. | in practice |
| `expired` | The order window closed with no confirmed payment. | in practice |

There are only four. There is no intermediate "settling" state — on-ramp goes straight from `pending` to an end state.

**`completed` is the only strictly immutable status.** `failed` and `expired` are end states you should treat as terminal for your own flow control — nothing further is expected, and a new order is the way forward — but they are not sealed: if a late confirmation shows the customer's money *was* collected, the order still moves to `completed` and `onramp.completed` fires. This is deliberate; the customer was charged, so the order has to reflect that. The practical rule: **keep handling `onramp.completed` for an order even after you have seen it `expired` or `failed`,** and never mark a payment permanently abandoned in your own system without being idempotent about a later completion.

The reverse never happens — an order that is `completed` or `expired` is never moved to `failed`.

`release_tx_hash` is the on-chain transfer of USDC to your `release_address`. It is recorded independently of the status transition and usually lands shortly after `completed` — but the two are separate events and either order is possible. `receipt_number` is the local payment receipt from the customer's confirmation.

## Webhook events

On-ramp emits four events to your configured webhook URL:

| Event | Fires when |
| --- | --- |
| `onramp.completed` | The local currency was collected. Order is `completed`. |
| `onramp.released` | The on-chain USDC transfer to `release_address` was recorded. **Carries `release_tx_hash`. Does not change the order's status.** |
| `onramp.failed` | The prompt did not produce a payment. Order is `failed`. |
| `onramp.expired` | The order window closed unpaid. Order is `expired`. |

`onramp.released` is the one with no off-ramp equivalent, and the one most likely to surprise you: it is a *money-arrived* signal, not a state change, and it can arrive before or after `onramp.completed`. If you credit a user on `onramp.completed`, treat `onramp.released` as your on-chain receipt; if you need the funds confirmed on Base before crediting, key off `onramp.released` instead. Do not assume an ordering between them, and do not assume `onramp.released` implies you have already processed `onramp.completed`.

A delivery your endpoint doesn't acknowledge with a 2xx is retried, so any event can arrive more than once. Make your handler idempotent on `order_id` and `event` together — not on `order_id` alone, since one order legitimately produces two different events.

`onramp.expired` is delivered whichever way an unpaid order expires: the background sweep, or `GET /api/onramp/orders/{order_id}` observing a still-`pending`, past-window order and expiring it in-band. Earlier versions delivered nothing on that second path — the in-band flip put the order out of reach of the sweep — so polling an order past its window cost you its expiry webhook. It delivers now, exactly once. Delivery is retried but not guaranteed, so reconciling your own `pending` orders past `expires_at` remains a sound backstop, and an `expired` status on a read is terminal in its own right.

Payload:

```json
{
  "event": "onramp.completed",
  "order_id": "8f2b1c44-9a3e-4d21-8b77-6c0e5a1d9f30",
  "external_reference": "invoice-4471",
  "status": "completed",
  "currency": "KES",
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

The priced fields (`amount_local`, `fee`, `exchange_rate`) are `0` placeholders for the same reason as in the endpoint reference.

Note the field names differ from the order object: `exchange_rate` (not `rate`), and there is no `release_chain`, `release_asset`, or `expires_at`.

**Optional fields are omitted from the webhook payload when unset** — `failure_reason` appears on `onramp.failed`, `release_tx_hash` on `onramp.released` and afterwards. This is the opposite of the order object, which keeps the key and sets it to `null`. Write your webhook checks against a missing key, and your order-object checks against `null`; a single shared helper that assumes one behaviour will misread the other surface.

Signed with HMAC-SHA256 over the raw request body using your webhook secret, in the `X-Minisend-Signature` header (lower-case hex). The header is only attached when a webhook secret is configured on your account — if none is set, deliveries arrive unsigned, so treat a missing signature as a configuration problem to fix rather than something to skip verification for. Verify against the raw bytes, not a re-serialized parse. Full delivery, retry, and verification detail is in `references/webhooks.md`.

## Currency support

**On-ramp is KES only.** M-Pesa and Airtel Money in Kenya, and nothing else, today.

Do not carry the off-ramp currency list over. Off-ramp pays out KES, NGN, GHS, and UGX; on-ramp collects KES alone. Anything else is rejected outright:

```json
{ "error": "Only KES (M-Pesa) onramp is supported." }
```

Mobile networks are `Safaricom` and `Airtel` — the same two canonical values off-ramp uses for KES, and the same accepted phone-number input shapes. See `references/recipients.md` for the formats. Kenyan numbers on other carriers are real numbers but have no route here, and are rejected with `Only Safaricom and Airtel numbers are supported.`

## Limits

### The minimum: 100 KES **net**

**The floor is 100 KES net — not the gross the customer is charged.** "Net" is the portion that converts to USDC, after the Minisend fee comes out of the total. Because the fee sits on top of the net, the amount the customer's phone is prompted for is always somewhat above 100 KES even for the smallest permitted order. This is the single most misread number in the on-ramp API, and it has been published wrong before. Do not compute the fee from it, and do not assume "the minimum charge is 100 KES."

Two error messages enforce it, one per amount direction. Note that the first says "at least 100 KES" without the word *net* — it is a net figure regardless:

```
Amount converts to only <n> KES net — M-Pesa onramp requires at least 100 KES. Try a larger amount.
After the fee, only <n> KES converts to USDC — M-Pesa onramp requires at least 100 KES net. Try a larger amount.
```

The practical way to handle this: don't precompute a USDC minimum. Call `POST /api/onramp/quote` and let it tell you. The USDC figure that clears 100 KES net moves with the exchange rate.

### The maximum

The gross charged to the customer must also fall inside the supported per-transaction band for KES: **20 to 250,000 KES**. The lower bound is inert — the 100 KES net floor always binds first — so in practice this is a ceiling of 250,000 KES on what one order can charge.

```
Amount converts to <n> KES, outside the supported M-Pesa range of 20–250,000 KES per transaction.
amount_kes must be within the supported M-Pesa range of 20–250,000 KES per transaction.
```

Both are `400`, returned before anything is created and before any phone rings.

## Fees

A Minisend fee applies to each on-ramp order, and it is **added on top of the amount that converts to USDC** — the opposite of off-ramp's KES path, where the fee is deducted from what the recipient receives. The customer is charged `amount_local` (the gross), the `fee` portion of it is Minisend's, and the remainder converts to the `amount_usdc` released to your address.

The two request directions are just two ways of pinning this down:

- **`amount_usdc`** — you fix what you receive; the customer's charge is grossed up to cover the fee.
- **`amount_kes`** — you fix what the customer is charged; the fee is carved out of it and you receive whatever the remainder converts to.

Whichever you use, read `amount_local` back and show *that* to the customer before they get the prompt. Never compute the gross yourself from a rate, and never hardcode a fee.

For current rates and fee terms, contact Minisend at `info@minisend.xyz`.

## Failure modes

Everything that can go wrong after the prompt is sent, and what you observe.

| What the customer does | Order becomes | Event | `failure_reason` |
| --- | --- | --- | --- |
| Declines / cancels the prompt | `failed` | `onramp.failed` | `stk_failed: <detail>` |
| Has insufficient balance | `failed` | `onramp.failed` | `stk_failed: <detail>` |
| Ignores the prompt until it dies on the handset | `failed`, or `expired` if no failure notice ever arrives | `onramp.failed` or `onramp.expired` | `stk_failed: <detail>`, or none on expiry |
| Never receives a prompt (send failed at creation) | `failed`, immediately | none | `stk_initiation_failed: <detail>` |
| Pays, but confirmation is slow | `pending` until confirmed, then `completed` | `onramp.completed` | — |
| Pays after the window closed | `expired` first, then `completed` when confirmed | `onramp.expired` then `onramp.completed` | — |

Notes that matter in code:

- **A declined prompt and an ignored prompt are not distinguishable to you.** Both land as `failed` with a `stk_failed:` reason whose detail comes from the mobile-money network. Don't branch on the detail text; it isn't a stable enum.
- **`failure_reason` is a diagnostic string, not a code.** Surface it to your own support tooling, not to logic and not verbatim to end users.
- **The creation-time failure emits no webhook** — the order goes to `failed` before you ever learn its `order_id`. Your only signal is the `502` on the create call.
- **The order window (30 minutes) is much longer than the prompt's life on the handset (a minute or two).** An order sitting `pending` at minute five is not waiting for the customer to act; the prompt is long gone. It is waiting for a confirmation or failure notice that may still arrive. Don't design a UI that tells the customer to keep looking at their phone for the full window.
- **In every failure case, the remedy is a new order.** There is no re-send, no resume, no retry endpoint. Mind the per-phone cap when you retry — five prompts per ten minutes to the same number, counted across all accounts.

## Worked example

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
    case 'onramp.completed':
      // Cash collected. event.external_reference is the `reference` you sent.
      // May legitimately arrive AFTER onramp.expired or onramp.failed.
      return markCollected(event.external_reference, event.receipt_number)
    case 'onramp.released':
      // USDC is on-chain at your release_address. Independent of the status
      // transition above — can arrive before OR after onramp.completed.
      return recordRelease(event.order_id, event.release_tx_hash)
    case 'onramp.failed':
      // Declined, timed out, or insufficient balance. Create a NEW order to retry.
      return markFailed(event.external_reference, event.failure_reason)
    case 'onramp.expired':
      // Window closed unpaid. Not guaranteed to arrive — reconcile yourself too.
      return markExpired(event.external_reference)
  }
}
```

## Common mistakes

- **Treating the phone number as a recipient.** In on-ramp the phone belongs to the *payer*, who is charged. Nobody receives local currency. The `address` is the only destination on the order, and it is yours.
- **Sending someone else's wallet address as `address`.** There is no per-order refund path and no recipient validation here. The USDC goes where you say.
- **Calling create to "check" something.** Every accepted create call rings a real phone and burns one of ten per minute — and one of five per ten minutes for that number, shared with every other integrator. Use `POST /api/onramp/quote` for anything exploratory.
- **Building a re-send or resume.** There isn't one. A dead prompt means a new order.
- **Retrying a `502 Failed to start the M-Pesa payment` with the same `Idempotency-Key`.** You get the original `failed` order back and no prompt. Use a new key.
- **Reading the 100 KES minimum as a minimum charge.** It is a net figure; the customer is always charged more than that.
- **Assuming `onramp.released` follows `onramp.completed`.** No ordering is guaranteed, and `onramp.released` does not change the order's status.
- **Deduplicating webhooks on `order_id` alone.** One order legitimately produces two different events. Key on `order_id` plus `event`.
- **Sealing an order in your own system on `expired` or `failed`.** A late confirmation can still complete it. Handle `onramp.completed` idempotently at any point.
- **Assuming on-ramp supports the off-ramp currencies.** It is KES only.
- **Sending `network: "mpesa"` or `"safaricom"`.** Only the exact strings `Safaricom` and `Airtel` are honoured; anything else is ignored without an error. Omit the field and let it auto-detect.
- **Looking for `reference` in the response.** You send `reference`; you get back `external_reference`.
