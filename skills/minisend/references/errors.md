# Errors

Every status code the Minisend APIs return, what causes it, and what to do about it. Product-specific detail lives in `references/offramp.md`, `references/onramp.md`, `references/checkout.md`, `references/wallets.md`, and `references/recipients.md`; this file is the cross-product map.

## The shape

Almost every error is a JSON object with a single `error` string:

```json
{ "error": "Invalid API key" }
```

Two exceptions to know about before you write a generic error handler:

- **`POST /api/offramp/validate-account`** returns `422 { "valid": false, "error": "…" }` — the `error` key is there, plus a `valid` flag.
- **Rate-limit responses vary by endpoint** — three different bodies, below.

**Match on the status code, never on the message text.** Messages interpolate live values (order status, network name, currency, amount bands), are not a stable API, and differ in trivia between endpoints — off-ramp and on-ramp return `Invalid JSON body.` with a full stop, the wallet API returns `Invalid JSON body` without one. Log the string; branch on the code.

## Which error you get first

The checks run in a fixed order, and the earlier ones fire before your request body is even looked at. This matters because **a request rejected late still consumes the caps checked earlier.**

For an authenticated off-ramp, on-ramp, or checkout call:

1. **`503`** — the product is switched off platform-wide.
2. **`429`** — the general per-client limit. Checked **before the API key is read**, so requests with a bad key or no key count against it too.
3. **`401`** — missing or malformed `Authorization` header, then an unknown or revoked key.
4. **`403`** — the account is inactive, then the scope/capability access gate.
5. **`429`** — the per-account creation cap, on creation endpoints.
6. **`400`** — JSON parsing, then body validation.

The practical consequence: **a malformed body still costs you one of your per-minute creates.** Validate client-side before calling a creation endpoint.

**Step 6 splits on the product.** Off-ramp, on-ramp, and the wallet API parse the body defensively and return `400` for malformed JSON. **`POST /api/merchant/checkout` does not** — unparseable JSON there falls through to the generic handler and comes back as `500 { "error": "Failed to create checkout session" }`. So on that one endpoint, a `500` can mean "your request body was not JSON" rather than "something broke on our side". Send valid JSON with `Content-Type: application/json` before reading a `500` there as a Minisend fault.

## 400 — the request was understood and rejected

The largest category. Grouped by where it comes from.

### Body parsing

| Body | Endpoints | Fix |
| --- | --- | --- |
| `{ "error": "Invalid JSON body." }` | Off-ramp and on-ramp | Send a syntactically valid JSON object with `Content-Type: application/json`. |
| `{ "error": "Invalid JSON body" }` | Wallet API (note: no full stop) | Same. |

### Off-ramp

| Body | Cause |
| --- | --- |
| `{ "error": "Invalid amount. Must be a positive number (USDC)." }` | `amount` missing, not a JSON number, not finite, or zero/negative. **A numeric string fails this too.** |
| `{ "error": "Amount below minimum of 0.5 USDC." }` | Under the per-order USDC minimum. |
| `{ "error": "Amount exceeds maximum of 50000 USDC." }` | Over the per-order USDC maximum. |
| `{ "error": "Invalid currency. Supported: KES, GHS, NGN, UGX." }` | `currency` missing or unsupported. Compared after upper-casing, so `kes` passes. |
| `{ "error": "refund_address is required and must be a valid 0x EVM address." }` | Missing or malformed `refund_address`. Required on **every** off-ramp order. |
| `Amount converts to <n> <CURRENCY>, outside the supported range of <min>–<max> <CURRENCY> per transaction (≈ <min>–<max> USDC at the current rate).` | The converted local amount falls outside the currency's band. Comes from pricing, not parsing, and is returned before anything is created. |
| `{ "error": "transaction_hash must be a 0x-prefixed 32-byte hex hash." }` | On `POST /api/offramp/orders/{order_id}/deposit`: the hash is not `0x` plus exactly 64 hex characters. |

Recipient-object messages — `Missing recipient object.`, `recipient.account_name is required.`, the per-method required-field messages, the phone-format message, the mobile-network message — are listed verbatim in `references/recipients.md`. They are stable enough to fix a payload from without another round trip.

### On-ramp

| Body | Cause |
| --- | --- |
| `{ "error": "address is required and must be a valid 0x EVM address (Base USDC release destination)." }` | Missing or malformed release address — **your own** address. |
| `{ "error": "phone is required." }` | No `phone`. |
| `{ "error": "Please enter a valid Kenyan phone number." }` | Not a recognisable Kenyan mobile shape. |
| `{ "error": "This Kenyan number doesn't look right. Please check it and try again." }` | Right shape, prefix not allocated to a known carrier. |
| `{ "error": "Only Safaricom and Airtel numbers are supported." }` | A real Kenyan number on a carrier with no mobile-money route. |
| `{ "error": "Only KES (M-Pesa) onramp is supported." }` | `currency` was not `KES`. |
| `{ "error": "Provide exactly one of amount_usdc or amount_kes (positive number)." }` | Both amounts, neither, or a non-positive one. |
| `Amount converts to only <n> KES net — M-Pesa onramp requires at least 100 KES. Try a larger amount.` | Below the net floor. **This is a net figure**, not the charge the customer sees. |
| `After the fee, only <n> KES converts to USDC — M-Pesa onramp requires at least 100 KES net. Try a larger amount.` | Same floor, from the `amount_kes` direction. |
| `Amount converts to <n> KES, outside the supported M-Pesa range of 20–250,000 KES per transaction.` | Outside the per-transaction band. |
| `amount_kes must be within the supported M-Pesa range of 20–250,000 KES per transaction.` | Same band, from the `amount_kes` direction. |

### Checkout

| Body | Endpoint | Cause |
| --- | --- | --- |
| `{ "error": "Invalid amount. Must be a positive number (USDC)." }` | `POST /api/merchant/checkout` | Missing, non-numeric, non-finite, or non-positive `amount`. |
| `{ "error": "Amount exceeds maximum of $50,000 USDC per checkout." }` | `POST /api/merchant/checkout` | Above the per-session ceiling. **Read the ceiling from the message rather than hardcoding it.** |
| `{ "error": "Missing merchant slug" }` | `POST /api/merchant/pay`, `POST /api/merchant/pay/mpesa` | No `slug`. |
| `{ "error": "Missing slug" }` | `GET /api/merchant/pay/info` | No `slug` query parameter. Note the different wording from the one above. |
| `{ "error": "Amount must be between $0.01 and $10,000 USDC" }` | `POST /api/merchant/pay` | Outside the payment-link ceiling, which is **lower** than the authenticated create path's. |
| `{ "error": "Enter a valid amount" }` | `POST /api/merchant/pay/mpesa` | `amount_kes` missing or unusable. |
| `{ "error": "Missing phone number" }` | Both M-Pesa endpoints | No `phone`. |
| `{ "error": "Amount is outside M-Pesa limits" }` | `POST /api/merchant/checkout/{session_id}/mpesa` | The session amount does not price into the permitted KES band. |
| `{ "error": "Amount must be between KES 20 and KES 250,000" }` | `POST /api/merchant/pay/mpesa` | Outside the band — **also fires when the amount is nominally in range but too small once the fee is taken out.** |

### Wallets

| Body | Cause |
| --- | --- |
| `{ "error": "walletRef is required: 1-128 chars, letters/numbers/_/:/./- only" }` | Missing, empty, not a string, too long, or containing a disallowed character. **A snake_case `wallet_ref` in the request body lands here** — requests are camelCase, responses are snake_case. |
| `{ "error": "walletRef must be 1-128 chars, letters/numbers/_/:/./- only" }` | The same rule on `GET /api/v1/wallets/by-ref/{wallet_ref}`, worded differently from the create call. Match on status, not text. |
| `{ "error": "wallet_id must be a wallet id (UUID). To look a wallet up by your own reference, use GET /api/v1/wallets/by-ref/{walletRef}." }` | `GET /api/v1/deposits?wallet_id=…` was given something that is not a UUID. Deliberately a `400` rather than an empty result set, which would read as "this wallet received nothing". |
| `{ "error": "chain must be one of BASE, MATIC, ARB, OP, ETH, AVAX" }` | `chain` present but not one of the six, **including a correct name in the wrong case**. |
| `{ "error": "metadata must be a JSON object" }` | `metadata` was a string, number, array, or `null`. |
| `{ "error": "No active master wallet for <Network> — activate this chain before creating wallets on it." }` | The chain is valid but not activated on your account. **This is an account-state problem returned as a `400`, not a `403`** — and no runtime retry will fix it. Activate the chain in the dashboard first. |

## 401 — the request was not authenticated

| Body | Cause | Fix |
| --- | --- | --- |
| `{ "error": "Missing or invalid Authorization header. Expected: Bearer ms_live_..." }` | No `Authorization` header, or one that does not start with `Bearer `. Off-ramp, on-ramp, checkout. | Send `Authorization: Bearer ms_live_…`. Note the required space after `Bearer`. |
| `{ "error": "Missing or invalid Authorization header. Expected: Bearer wsk_live_..." }` | Same, on the wallet API. | Send `Authorization: Bearer wsk_live_…`. |
| `{ "error": "Invalid API key" }` | The key was well-formed as a header but not recognised: unknown, revoked, mistyped — **or from the wrong namespace.** Both APIs return the identical message. | See below. |

**`Invalid API key` is the response you get for a namespace mistake**, and it reads like a typo. An `ms_live_` key presented to the wallet API, or a `wsk_` key presented to off-ramp, on-ramp, or checkout, fails here with no hint that the key itself is fine. A withdrawn `wsk_test_` prefix fails the same way. Check which key you are sending before you assume the key is bad. `references/authentication.md` has the namespaces.

## 403 — authenticated, but not permitted

Two distinct causes with **different bodies**, and one of those bodies covers **two indistinguishable underlying causes**. See [This error looks like that error](#this-error-looks-like-that-error).

| Body | Cause | Fix |
| --- | --- | --- |
| `{ "error": "Your account doesn't have <product> access yet. Please contact info@minisend.xyz to request access." }` | The access gate. `<product>` is `checkout`, `off-ramp`, or `onramp`. | Contact `info@minisend.xyz`. |
| `{ "error": "Merchant account not found or inactive" }` | The key is valid but the account behind it is inactive. Off-ramp, on-ramp, checkout. | Contact Minisend — nothing in your code fixes this. |
| `{ "error": "Tenant account not found or inactive" }` | The same condition on the wallet API. | As above. |

**The access-gate 403 is two gates behind one message.** Every scoped endpoint checks that the key carries the required scope **and** that the account has the product enabled. Both failures return the identical body — deliberately, so the response cannot be used to probe which layer is missing. You cannot tell them apart, and the remedy is the same either way.

The defaults are asymmetric: **checkout is opt-out** (enabled by default; the gate exists so Minisend can switch a specific account off), while **off-ramp and on-ramp are opt-in** (disabled until enabled for you). So a fresh account hitting this on off-ramp is the expected first-run experience; hitting it on checkout means something was actively turned off.

## 404 — not found

| Body | Endpoints |
| --- | --- |
| `{ "error": "Order not found." }` | Off-ramp and on-ramp single-order reads, and the off-ramp deposit endpoint. |
| `{ "error": "Checkout session not found" }` | Checkout status and M-Pesa endpoints. |
| `{ "error": "Merchant not found" }` | Payment-link endpoints, for an unknown slug **and** for an inactive account. Also returned by `POST /api/merchant/checkout/{session_id}/mpesa` when the session resolves but the account behind it cannot be loaded — so on that endpoint a `404` is two different objects, and the body is the only way to tell which. |
| `{ "error": "Wallet not found" }` | `GET /api/v1/wallets/{wallet_id}`, `…/{wallet_id}/balance`, `…/{wallet_id}/deposits`, and `GET /api/v1/wallets/by-ref/{wallet_ref}`. |

**Every one of these deliberately conflates "does not exist" with "belongs to someone else."** An order id owned by another account returns the same 404 as a made-up one. Do not build logic that tries to distinguish them.

**On the wallet API, a `404` only happens for a well-formed UUID.** Anything that is not a UUID — a `walletRef`, a numeric id, a truncated UUID — produces a `500` instead, so a `404` branch written to catch "that was a ref, not an id" will never fire. Guard the value against a UUID pattern before building the URL.

## 409 — conflict with the object's current state

Off-ramp deposit submission and the checkout M-Pesa prompt are the only places this appears.

| Body | Cause | Fix |
| --- | --- | --- |
| `{ "error": "This order settles automatically once funds arrive at deposit_address. No hash submission needed for this currency." }` | You called the deposit endpoint on an NGN order. | Do not submit a hash on the NGN path. Branch on the payout currency. |
| `{ "error": "Order is <status> and can no longer be paid." }` | The order has moved past `pending`. The live status is interpolated. | Read the order; act on its actual status. |
| `{ "error": "Order expired before a deposit was submitted. Create a new order." }` | The deposit window closed. The order is flipped to `expired` by this call, which also delivers `offramp.expired`. | Create a new order. |
| `{ "error": "This transaction hash was already used for another order." }` | One transfer cannot pay two orders. | Send a separate transfer per order. |
| `{ "error": "A payment request is already on its way to your phone. Wait a moment before retrying." }` | A prompt was already sent on this checkout session within the last 90 seconds. | **A double-charge guard, not a throttle.** Surface the message; do not loop through it. |

## 410 — gone

Checkout M-Pesa endpoints only.

| Body | Cause |
| --- | --- |
| `{ "error": "Session is not payable" }` | The session is no longer `pending`. |
| `{ "error": "Session expired" }` | The session is past `expires_at`. |

Both mean the same thing for your flow: this session cannot take a payment. Create a new one.

## 422 — the request was well-formed but the thing it describes was rejected

Two of these, and **they behave oppositely on retry.**

| Body | Endpoint | Retryable? |
| --- | --- | --- |
| `{ "valid": false, "error": "Recipient validation failed. Confirm the account details and try again." }` on `validate-account`, or `{ "error": "Recipient validation failed. Confirm the account details and try again." }` on quote/create | Off-ramp quote, validate-account, order creation | **No order was created.** Fix the recipient details and call again. Only hard-gated destinations (NGN bank, KES `BANK_TRANSFER`) can produce this — see `references/recipients.md`. |
| `{ "error": "Payment verification failed: <detail>. Confirm the hash, amount, and chain, then retry." }` | `POST /api/offramp/orders/{order_id}/deposit` | **Yes.** The order stays `pending` and the claim on it is released, so a corrected hash on the same order goes through. |

## 429 — rate limited

**Four different bodies across the platform.** Match on the status code.

| Body | Which limit | Scope |
| --- | --- | --- |
| `{ "error": "Rate limit exceeded" }` | The general limit: 60 requests per 60 seconds. Checked **before the API key is read**, so unauthenticated and bad-key requests count against it. | Per calling client, keyed by IP — **not per key.** |
| `{ "error": "Too many … recently. Please slow down, or contact info@minisend.xyz if you need a higher limit." }` | Per-account creation caps: checkout session 30/min, off-ramp order 20/min, off-ramp deposit 20/min, on-ramp order 10/min. **Each has its own wording and they do not share a template** — the three creation caps read "Too many checkout sessions created recently", "Too many off-ramp orders created recently", and "Too many onramp orders created recently", while the deposit cap reads "Too many deposit submissions recently", with no "created". | Per account. |
| `{ "error": "Too many payment requests sent to this phone number recently. Please wait before retrying." }` | On-ramp only: 5 prompts per 10 minutes to one phone number. | **Per phone number, across all accounts** — another integrator's traffic to that number counts against it. |
| `{ "error": "Too many requests" }` | The public checkout and payment-link endpoints, each with its own per-IP limit. | Per IP. |

`X-RateLimit-Remaining` is attached **only to the 429 itself**, and not to every 429 at that. You cannot read it on a successful response to throttle preemptively — track your own request rate client-side.

Because the general limit is keyed by IP rather than by key, **every process behind one egress IP shares one budget.** A busy serverless region or a shared NAT will hit it sooner than your per-account maths suggests.

## 5xx — something on the Minisend side

The important question for each of these is **whether anything was created before it failed**, because that decides how you retry.

| Status | Body | Was anything created? | Retry |
| --- | --- | --- | --- |
| `502` | `{ "error": "Failed to fetch balance" }` | No. A read. | Yes. The upstream balance lookup failed; it says nothing about the wallet, which still exists. |
| `502` | `{ "error": "Failed to generate quote." }` | No. | Yes, immediately. Quotes reserve nothing. |
| `502` | `{ "error": "Failed to price the order." }` | **No.** | Yes, with the same `Idempotency-Key`. |
| `502` | `{ "error": "Failed to provision deposit address. Retry with a new Idempotency-Key." }` | Off-ramp: the order id is spent. | **New `Idempotency-Key`**, exactly as the message says. |
| `502` | `{ "error": "Failed to start the M-Pesa payment: <detail>. Create a new order to retry." }` | **Yes — an on-ramp order exists and is already `failed`.** No prompt reached the customer, no webhook fires, and the response carries no `order_id`. | **New `Idempotency-Key`.** Replaying the old one returns the same `failed` order and sends nothing. |
| `502` | `{ "error": "Payment provider returned no transaction code" }`, or a passed-through failure message | The checkout M-Pesa prompt could not be sent. **Nothing was charged.** On `POST /api/merchant/pay/mpesa`, a plain `pending` session is left behind, payable in stablecoin, with no `session_id` in the response. | Call again; you get a new session. |
| `500` | `{ "error": "Failed to create order." }` | No. | Yes. |
| `500` | `{ "error": "Failed to create checkout session" }` | No. | Yes. |
| `500` | `{ "error": "Failed to create payment session" }` | No. | Yes. |
| `500` | `{ "error": "Failed to start payment" }` | Session creation plus prompt, on the payment-link M-Pesa path. | Call again. |
| `500` | `{ "error": "Failed to create wallet" }` | Possibly. | Retry with the **same** `walletRef` — the call is create-or-get, so a retry after a dropped response cannot mint a second address. |
| `500` | `{ "error": "Merchant has no deposit address. Please re-register." }` / `{ "error": "Merchant has no deposit address. Please contact support." }` / `{ "error": "Merchant wallet unavailable" }` | No. | **Not retryable.** Three different bodies for one account-provisioning condition, across the authenticated create, the payment-link create, and the M-Pesa endpoints. Contact Minisend. |
| `500` | `{ "error": "Failed to fetch checkout session" }` / `{ "error": "Failed to fetch merchant info" }` / `{ "error": "Failed to quote" }` | Reads. | Yes. |
| `500` | `{ "error": "Failed to fetch deposits" }` / `{ "error": "Failed to fetch wallet" }` | Reads, on the wallet API. | Yes. |

## 503 — the product is switched off

| Body | Meaning |
| --- | --- |
| `{ "error": "Off-ramp API is not available." }` | Off-ramp is disabled platform-wide. |
| `{ "error": "Onramp API is not available." }` | On-ramp is disabled platform-wide. |

This is **not** the same as your account lacking access — that is the `403` access gate. A `503` is checked before authentication and affects everyone. There is nothing to fix on your side; retrying will keep failing until the product is switched back on.

## This error looks like that error

The pairs that genuinely get confused, and how to tell them apart.

### Two 403s from two gates, one message

`Your account doesn't have <product> access yet.` is returned when **the key lacks the scope**, and also when **the account lacks the capability**, and also when both are missing. The bodies are byte-identical. This is deliberate: the response must not reveal which layer is missing.

**Do not write code that branches on which one it was.** You cannot know, and the remedy is the same: contact `info@minisend.xyz`. If you are debugging, the useful signal is elsewhere — a key with the wrong scope will typically work on the product it *was* issued for, while a capability problem fails for every key on the account.

### That 403 versus `Merchant account not found or inactive`

Different bodies, different problems, adjacent in the pipeline. The access gate means "this product is not open to you"; `not found or inactive` means **the whole account is switched off** and *every* product will fail. If you see the second one, stop debugging scopes.

### `Invalid API key` versus a namespace mistake

Same body, very different cause. An `ms_live_` key on the wallet API and a `wsk_` key on off-ramp both return `Invalid API key`, which reads like a typo and is not one. Check the prefix against the endpoint before regenerating anything. Same for a `wsk_test_` prefix, which is no longer a valid namespace at all.

### `Rate limit exceeded` versus `Too many requests` versus the creation caps

Three bodies, three limiters, different scopes — general per-IP, public per-IP, and per-account creation. A fourth, the on-ramp per-phone cap, is not yours to spend at all. **All four are 429.** Match the status code; use the text only for logging.

### The two 422s

`Recipient validation failed` means **nothing was created** — fix the details and call again. `Payment verification failed` means the order **still exists and is still `pending`** — submit a corrected hash to the same order. Treating the second as fatal strands a real order; treating the first as retryable-as-is loops forever.

### 400 chain-not-activated versus 403 no-access

The wallet API's `No active master wallet for <Network>` is a `400`, even though it is an account-state problem you would expect as a `403`. It is also **not fixable at runtime** — activation is a dashboard action no API call can perform. Catching it and retrying will fail identically forever. Treat it as a deployment prerequisite.

### 404 on the wallet API covers three different mistakes

`GET /api/v1/wallets/{wallet_id}` returns the same `404 { "error": "Wallet not found" }` for a UUID that does not exist, one that belongs to another account, and a path segment that is not a UUID at all — most often a `walletRef` passed where an `id` was expected. The uniformity is deliberate for the first two (no cross-account enumeration), and convenient for the third: a `404` handler catches the ref mistake instead of it surfacing as a server error.

That third case now has a proper route: `GET /api/v1/wallets/by-ref/{wallet_ref}` takes your own identifier directly. It returns `400` for a ref that breaks the character rules and `404` for one that is well-formed but unknown, so the two mistakes are distinguishable there in a way they are not on the by-id route.

It does mean a `404` alone will not tell you *which* of the three happened. Validate the value against a UUID pattern on your side if you need to distinguish "I sent the wrong kind of identifier" from "this wallet is gone."

### 409 expired versus 410 expired

Off-ramp returns `409 Order expired before a deposit was submitted.` The checkout M-Pesa endpoints return `410 Session expired`. Same idea, different products, different codes. Both are terminal for the object in question, and both mean "create a new one."

### The three "no deposit address" 500s

`Merchant has no deposit address. Please re-register.`, `Merchant has no deposit address. Please contact support.`, and `Merchant wallet unavailable` are the same account-provisioning condition surfacing on three different endpoints. None of them is retryable and none of them is your bug.

## Handling errors generically

```ts
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://merchant.minisend.xyz${path}`, init)

  // Don't assume an error body is JSON — one wallet-API 500 is not.
  const raw = await res.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new MinisendError(res.status, raw.slice(0, 200))
  }

  if (!res.ok) {
    // Branch on status. The message is for your logs, not your control flow.
    throw new MinisendError(res.status, (body as { error?: string }).error ?? raw.slice(0, 200))
  }
  return body as T
}

class MinisendError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`${status} ${detail}`)
  }
}
```

What to do with each class:

| Status | Action |
| --- | --- |
| `400`, `422` | Fix the request. Never retry unchanged — except the deposit-endpoint `422`, which takes a corrected hash on the same order. |
| `401`, `403` | Configuration. Never retry in a loop; surface it. |
| `404`, `409`, `410` | The object is not in the state you assumed. Re-read it and branch on its actual status. |
| `429` | Back off. Respect the caps in `references/authentication.md`; do not retry a creation cap tightly. |
| `500`, `502` | Check the table above for whether anything was created before retrying, and whether the retry needs a **new** `Idempotency-Key`. |
| `503` | The product is off platform-wide. Nothing to fix; do not hammer it. |

## Common mistakes

- **Matching on error text.** Messages interpolate live values and vary in punctuation between endpoints. Branch on the status code.
- **Assuming every error body is JSON.** One wallet-API `500` is not, and a `res.json()` call throws while parsing instead of reporting the status.
- **Trying to tell the two 403 gates apart.** They are byte-identical by design.
- **Reading `Invalid API key` as "the key is broken".** It is also what a wrong-namespace key returns.
- **Retrying a `502 Failed to start the M-Pesa payment` with the same `Idempotency-Key`.** You get the original `failed` order back and no prompt is sent.
- **Retrying a `502 Failed to provision deposit address` with the same `Idempotency-Key`.** That order id is spent; the message tells you to use a new one.
- **Treating the deposit endpoint's `422` as fatal.** The order is still `pending` and still payable with a corrected hash.
- **Catching the wallet API's chain-not-activated `400` and retrying at runtime.** Activation is a dashboard action; the retry will fail forever.
- **Assuming a `404` means "not mine".** It also means "does not exist", with no way to distinguish.
- **Retrying a per-account creation `429` tightly.** You will keep burning the cap. Back off.
- **Counting on `X-RateLimit-Remaining`.** It only appears on the 429, and not on all of them.
- **Validating the body after calling.** A malformed body still consumes a per-minute create.
- **Looping on the M-Pesa `409` cooldown.** It is a double-charge guard, not a throttle.
