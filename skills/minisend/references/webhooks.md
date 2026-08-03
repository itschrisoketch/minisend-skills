# Webhooks

## What arrives, and where

Minisend POSTs a signed JSON event to one URL configured on your account whenever an off-ramp order, an on-ramp order, or a checkout session reaches a state you need to know about.

**There is one webhook URL and one signing secret for the whole account.** Off-ramp, on-ramp, and checkout all deliver to the same endpoint — you cannot register a different URL per product. Branch on the payload's `event` field. The wallet API emits nothing at all (`references/wallets.md`).

Events are the path to rely on. Every product's status endpoint exists as a fallback. Note that in off-ramp, on-ramp, and checkout, reading an order or session past its expiry window expires it — the read is not side-effect-free, though it does deliver the expiry event. See [Gaps and guarantees](#gaps-and-guarantees).

## Setup

### The URL

Set it in the Minisend dashboard. It must be:

- **`https://`** — plain `http` is rejected.
- **A public hostname or IP.** `localhost`, `*.localhost`, `*.local`, `*.internal`, private and loopback address ranges, and any hostname that resolves into them are all rejected.
- **Free of credentials** — no `https://user:pass@host/...`.
- **At most 2048 characters.**

A URL that fails any of these is rejected when you save it, with the reason named.

The same check runs again immediately before every delivery attempt. **If your URL stops passing it — DNS moved, the host resolves to a private address — the event is refused outright and never retried.** It is dropped, not queued. That is a real way to lose events silently, so keep the hostname publicly resolvable.

For local development, use a public HTTPS tunnel. Pointing the URL at `localhost` will not work.

### The secret

The signing secret is generated when your account is created and shown once. If you no longer have it, generate a new one from the dashboard's webhook section — it is returned in plaintext exactly once, and it is not readable afterwards.

**Regenerating invalidates the previous secret immediately.** There is no overlap window and no dual-signing period, so deploy the new secret at the same time you rotate.

Two details that make rotation less painful than it sounds:

- **The signature is computed at send time with whatever secret is current.** A retry that was queued before the rotation is signed with the *new* secret when it eventually goes out — you do not need to keep the old secret around to drain a backlog.
- Only deliveries already in flight at the instant you rotate can carry the old signature.

**If no secret is configured, deliveries arrive with no `X-Minisend-Signature` header at all.** The requests still come. Treat a missing signature as a configuration problem to fix, not as a case to accept — an unsigned webhook endpoint is a public one that anyone can post to.

## The signature

| | |
| --- | --- |
| Header | `X-Minisend-Signature` |
| Algorithm | HMAC-SHA256 |
| Key | your webhook secret, as raw bytes |
| Message | the exact bytes of the request body |
| Encoding | lower-case hex, 64 characters |

The header value is the **bare digest**. There is no `t=`/`v1=` scheme, no version prefix, no `sha256=` prefix, and no timestamp anywhere in the request. Compare it directly against your computed digest, with a timing-safe comparison.

Because there is no timestamp, there is no replay window to enforce. Your defence against a replayed delivery is idempotency — see [Idempotency](#idempotency).

### Verify over the raw body — this is where integrations break

**Compute the HMAC over the exact bytes you received, before any JSON parsing.** Parsing and re-serializing produces different bytes — key order, whitespace, and number formatting all shift — and the signature will not match. This is the most common way a webhook integration fails, and it fails on every delivery rather than intermittently, so it is usually caught early. The nastier version is the near miss: a framework that parses the body for you and hands your handler an object, leaving you to `JSON.stringify` it back. That path *looks* right and never verifies.

Concretely, in the frameworks that do this to you:

- **Next.js App Router** — call `await request.text()`, not `await request.json()`. Parse afterwards.
- **Express** — mount `express.raw({ type: 'application/json' })` on the webhook route, not the global `express.json()`.
- **Flask** — `request.get_data()`, not `request.json`.
- **Go `net/http`** — `io.ReadAll(r.Body)`, then `json.Unmarshal` the same slice.

Verify first, parse second, always from the same buffer.

**And fail closed on a missing secret.** All three examples below refuse to start when `MINISEND_WEBHOOK_SECRET` is unset or empty, because the alternative is worse than a crash: an empty secret keys the HMAC on an empty string, so verification still "passes" for anyone who knows the variable is unset. An unset secret must reject every delivery — never accept one.

### TypeScript — Next.js App Router

```ts
// app/api/webhooks/minisend/route.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

const RAW_SECRET = process.env.MINISEND_WEBHOOK_SECRET
// Fail closed at boot. Without this, an unset or blank variable would key the
// HMAC on the empty string and verify() would ACCEPT anything signed with it.
if (!RAW_SECRET) throw new Error('MINISEND_WEBHOOK_SECRET is not set')
// Re-bind as `string`. TypeScript does not carry the narrowing above into the
// body of verify(), so passing RAW_SECRET straight to createHmac fails to
// compile under `strict` — which Next.js turns on by default.
const SECRET: string = RAW_SECRET

function verify(raw: string, signature: string): boolean {
  const expected = createHmac('sha256', SECRET).update(raw).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  // Length check first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  // RAW bytes. Never request.json() here — re-serializing breaks the signature.
  const raw = await request.text()
  const signature = request.headers.get('x-minisend-signature')

  if (!signature || !verify(raw, signature)) {
    return new Response('invalid signature', { status: 401 })
  }

  const event = JSON.parse(raw) as { event: string; [k: string]: unknown }

  // Record it durably, then return. Do the slow work out of band.
  await enqueue(event)

  return new Response(null, { status: 200 })
}
```

### Python — Flask

```python
import hashlib
import hmac
import json
import os

from flask import Flask, request

app = Flask(__name__)

# Fail closed at import. os.environ[...] raises if the variable is unset; the
# emptiness check covers the set-but-blank case. An empty secret would key the
# HMAC on b"" and accept anything signed with it.
SECRET = os.environ["MINISEND_WEBHOOK_SECRET"].encode()
if not SECRET:
    raise RuntimeError("MINISEND_WEBHOOK_SECRET is empty")


def verify(raw: bytes, signature: str) -> bool:
    expected = hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    # Compare BYTES, not str: compare_digest raises TypeError on a str
    # containing non-ASCII, which would turn a junk header into a 500 and a
    # pointless retry. errors="replace" makes the encode itself unable to raise.
    return hmac.compare_digest(expected.encode(), signature.encode("utf-8", "replace"))


@app.post("/webhooks/minisend")
def minisend_webhook():
    # RAW bytes. Never request.json here — re-serializing breaks the signature.
    raw = request.get_data()
    signature = request.headers.get("X-Minisend-Signature", "")

    if not verify(raw, signature):
        return "invalid signature", 401

    event = json.loads(raw)

    # Record it durably, then return. Do the slow work out of band.
    enqueue(event)

    return "", 200
```

`hmac.compare_digest` is the timing-safe comparison and handles a length mismatch without raising, so no separate length check is needed — but it **does** raise `TypeError` when handed `str` values containing non-ASCII characters, which is why both sides are encoded to `bytes` first.

### Go — `net/http`

```go
package minisend

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
)

var secret = mustSecret()

// Fail closed at boot. os.Getenv returns "" for an unset variable, which would
// key the HMAC on an empty secret and accept anything signed with it.
func mustSecret() []byte {
	s := os.Getenv("MINISEND_WEBHOOK_SECRET")
	if s == "" {
		panic("MINISEND_WEBHOOK_SECRET is not set")
	}
	return []byte(s)
}

func verify(raw []byte, signature string) bool {
	mac := hmac.New(sha256.New, secret)
	mac.Write(raw)
	expected := hex.EncodeToString(mac.Sum(nil))
	// hmac.Equal is constant-time and safe on unequal lengths.
	return hmac.Equal([]byte(expected), []byte(signature))
}

func Handler(w http.ResponseWriter, r *http.Request) {
	// RAW bytes. Unmarshal the same slice afterwards — never re-encode.
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}

	if !verify(raw, r.Header.Get("X-Minisend-Signature")) {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	var event struct {
		Event     string `json:"event"`
		OrderID   string `json:"order_id"`
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}

	// Record it durably, then return. Do the slow work out of band.
	enqueue(event.Event, raw)

	w.WriteHeader(http.StatusOK)
}
```

## What a delivery looks like

```
POST <your webhook URL>
Content-Type: application/json
User-Agent: Minisend-Webhooks/1.0
X-Minisend-Signature: <64 lower-case hex characters>    (only when a secret is configured)

{"event":"offramp.completed", ... }
```

- **Those are all the headers Minisend adds.** There is no event-id header, no delivery-id header, no timestamp header, and no retry-count header. Everything you can key on is in the body.
- **Redirects are not followed.** A `301`/`302` from your endpoint is not chased; it counts as a failed attempt. Register the final URL.
- **Your response must arrive within 10 seconds.** Slower than that and the attempt is aborted and treated as a failure.

## Event catalogue

> **About the numbers in the sample payloads below.** Every priced field — `amount_local`, `exchange_rate`, `fee` — is shown as `0` throughout this file. That is a placeholder, not a value. Read the real figures from the live payload; never hardcode them and never derive one from another.

Ten event names exist across three products. **Group them by product and do not assume symmetry** — the products differ in which events exist, which are terminal, and whether two events can describe the same object.

| Product | Events |
| --- | --- |
| Off-ramp | `offramp.completed`, `offramp.failed`, `offramp.expired` |
| On-ramp | `onramp.completed`, `onramp.released`, `onramp.failed`, `onramp.expired` |
| Checkout | `checkout.completed`, `checkout.failed`, `checkout.expired` |
| Wallets | none |

### Off-ramp

| Event | Fires when |
| --- | --- |
| `offramp.completed` | The order reached `completed` — the recipient was paid. |
| `offramp.failed` | The order reached `failed`. |
| `offramp.expired` | The deposit window closed with no accepted deposit. Delivered whether the sweep or a read expires the order. |

There is no event for `settling` and none for order creation. All three off-ramp statuses that emit an event are terminal and immutable, so **one order produces at most one distinct off-ramp event.** (Retries can still deliver that one event more than once.)

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

Always present: `event`, `order_id`, `status`, `amount_usdc`, `payout_currency`, `recipient_account_name`, `created_at`.
Omitted when unset: `external_reference`, `amount_local`, `exchange_rate`, `fee`, `settlement_receipt`, `completed_at`.

Field names differ from the order object — `payout_currency` (not `currency`), `exchange_rate` (not `rate`). Full field meanings are in `references/offramp.md`.

### On-ramp

| Event | Fires when |
| --- | --- |
| `onramp.completed` | The local currency was collected. The order is `completed`. |
| `onramp.released` | The on-chain USDC transfer to `release_address` was recorded. **Carries `release_tx_hash` and does not change the order's status.** |
| `onramp.failed` | The payment prompt did not produce a payment. The order is `failed`. |
| `onramp.expired` | The order window closed unpaid. Delivered whether the sweep or a read expires the order. |

Two on-ramp specifics that have no counterpart in the other products:

- **`onramp.released` is not a status change.** It is a money-arrived signal, delivered from a callback separate from the one that completes the order. **No ordering with `onramp.completed` is guaranteed** — it can arrive first, and its arrival does not imply you have already processed `onramp.completed`.
- **`onramp.completed` can follow `onramp.expired` or `onramp.failed`.** Only `completed` is immutable on an on-ramp order; a late confirmation that the customer really was charged moves an `expired` or `failed` order to `completed` and fires `onramp.completed`. This is deliberate.

So a single on-ramp order can legitimately produce two, or even three, different events.

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

Always present: `event`, `order_id`, `status`, `currency`, `amount_usdc`, `amount_local`, `fee`, `exchange_rate`, `customer_phone`, `mobile_network`, `release_address`, `created_at`.
Omitted when unset: `external_reference`, `receipt_number`, `release_tx_hash`, `failure_reason`, `completed_at`.

`failure_reason` appears on `onramp.failed`; `release_tx_hash` appears on `onramp.released` and on anything delivered after the release was recorded. The payload has no `release_chain`, `release_asset`, or `expires_at`. Full field meanings are in `references/onramp.md`.

### Checkout

| Event | Fires when |
| --- | --- |
| `checkout.completed` | The session reached `completed`. |
| `checkout.failed` | The session reached `failed`, by any route. |
| `checkout.expired` | The window passed with no deposit. |

**`checkout.expired` is delivered**, from whichever of two paths gets there first: the periodic sweep, or a read of the status endpoint past `expires_at`, which expires the session in-band. The status flip is atomic, so exactly one of them delivers and you will not see a duplicate. Earlier versions declared this event but emitted nothing.

**`checkout.completed` can arrive for a session you already saw end.** An M-Pesa-paid session whose payment confirms after the window closed goes `expired` → `completed` and fires the event, because the customer was charged. For a stablecoin-paid session, `expired` really is terminal.

**`checkout.failed` now covers every way a session reaches `failed`.** Earlier versions delivered it only from the payout leg, leaving five paths silent: a payout that could not be initiated, a deposit on a chain the account does not accept, a failed cross-chain sweep, a failure on the payout-confirmation path, and the settlement re-check the status endpoint performs on a session stuck at `settling`. That last one was the sharpest — the re-check delivered `checkout.completed` when it found the payout complete but nothing when it found it failed, so the very read that discovered a failure was the one guaranteed not to report it. All five deliver now.

Reconciling non-terminal sessions is still worth doing: delivery is retried but never guaranteed, and a `failed` you learn from a poll should be recorded from the poll rather than waiting for the event to repeat it.

```json
{
  "event": "checkout.completed",
  "session_id": "cs_3f9c2a71-5e64-4b8d-9a02-71c5d8e3b410",
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

Always present: `event`, `session_id`, `payment_method`, `amount_usdc`, `amount_expected_usdc`, `currency`, `status`, `created_at`.
Omitted when unset: `external_id`, `amount_local`, `exchange_rate`, `receipt`, `completed_at`, `amount_received_usdc`, `amount_matched`.

Note that checkout keys on `session_id`, not `order_id`, and echoes `external_id` rather than off-ramp's and on-ramp's `external_reference`. `currency` is the account's payout currency **except on an M-Pesa-paid session, where it is always `KES`**, because the local figures on those sessions describe the pay-in. Full field meanings are in `references/checkout.md`.

### Null versus absent — the payload is not the object

**Every one of these payloads omits an unset optional field entirely.** The corresponding order and session objects returned by the REST endpoints do the opposite for most fields: the key is present and carries `null`.

```ts
// Webhook payload — check for absence.
if (event.settlement_receipt !== undefined) { … }
if ('receipt' in event) { … }

// Order/session object — check for null. `'settlement_receipt' in order` is
// always true here and tells you nothing.
if (order.settlement_receipt !== null) { … }
```

A single shared helper that assumes one convention will misread the other surface. The REST-side conventions have per-product wrinkles of their own — off-ramp has genuinely-absent fee fields on some currencies, and checkout's session serializer mixes three conventions in one response — which are documented in `references/offramp.md` and `references/checkout.md`.

## The reconciliation hazard: `amount_usdc` on `checkout.completed`

**`amount_usdc` on a `checkout.completed` payload is the amount the session *expected*, not the amount that arrived.** It is copied from the session unchanged.

Checkout matches an incoming payment to a session by destination address and amount, with about a cent of slack. When nothing matches on amount and exactly one session is open on that address, the payment is attributed to it and settled for whatever actually arrived — stranding the customer's funds would be worse. The session completes, and `amount_usdc` still reports the original expected figure.

**What tells you is `amount_received_usdc`**, alongside `amount_matched`:

```ts
if (event.event === 'checkout.completed') {
  const received = event.amount_received_usdc ?? event.amount_usdc
  await ledger.record(event.session_id, received)
  if (event.amount_matched === false) {
    await ops.flagForReview(event.session_id)   // settled, but not the figure you quoted
  }
}
```

Both fields are omitted when no deposit was attributed, so fall back to `amount_usdc` only for events where nothing arrived.

**Do not book revenue from `amount_usdc`.** Book `amount_received_usdc`, treat `amount_matched: false` as needing review, and keep the number of simultaneously open sessions per account low — with two or more open, an off-amount payment is not attributed at all and parks for manual review instead. `references/checkout.md` has the full mechanics.

This applies to checkout only. Off-ramp and on-ramp amounts are fixed at order creation and are not subject to a matching fallback.

## Delivery, retries, and giving up

The first attempt is made inline with the state change that produced the event. **A response with a `2xx` status is a success. Everything else is a failure** — a `4xx`, a `5xx`, a redirect (not followed), a connection error, or a response slower than the 10-second timeout.

Up to **5 attempts** total, with a backoff factor of 4 from a 30-second base:

| Attempt | When |
| --- | --- |
| 1 | Immediately, inline with the state change |
| 2 | ~30 seconds after attempt 1 failed |
| 3 | ~2 minutes after attempt 2 failed |
| 4 | ~8 minutes after attempt 3 failed |
| 5 | ~32 minutes after attempt 4 failed |

**After the fifth failed attempt the event is abandoned.** There is no sixth try, no dead-letter queue you can read, and no notification that it happened. The state change is still visible on the REST endpoints — which is why reconciliation is not optional.

Three things about the schedule:

- **The delays are floors, not exact times.** Retries are picked up by a periodic sweep in batches, so a delivery arrives at or after its scheduled time, never before, and a large backlog drains over several sweeps.
- **Ordering is not guaranteed.** A retried event can land after a newer event for the same object, and events for different objects interleave freely. Order your own processing by the payload's timestamps and by your own state machine, never by arrival order.
- **A retry re-serializes the stored payload.** The content is the same, but the JSON field ordering is not guaranteed to be byte-identical to the first attempt. The signature always matches the body of the request it arrives on, so verification is unaffected — but **never deduplicate by hashing the raw body.**

And one that will bite if you misconfigure the URL: if the URL fails the public-HTTPS check at send time, the delivery is **refused and marked exhausted**, with no attempts at all. See [Setup](#setup).

## Idempotency

**Every event can arrive more than once.** A retry after your endpoint timed out — but succeeded internally — is the common case, and there is no delivery id to tell a retry from a first attempt. Your handler must be safe to run twice with the same input.

There is no `id` or `delivery_id` field. **Build the dedupe key from the payload:**

| Product | Dedupe on | Why |
| --- | --- | --- |
| Off-ramp | `order_id` + `event` | `order_id` alone is sufficient in practice — an order emits at most one distinct event — but the compound key costs nothing and keeps one code path across products. |
| On-ramp | `order_id` + `event` — **required** | One order legitimately produces several different events: `onramp.released` alongside `onramp.completed`, or `onramp.expired` then `onramp.completed`. Keying on `order_id` alone drops the second one as a duplicate. |
| Checkout | `session_id` + `event` | A session can deliver two different event names, and `session_id` alone collapses them — so a `checkout.completed` that legitimately follows an outcome you already recorded is dropped as a duplicate. M-Pesa-paid sessions complete after their window closes, which is exactly that shape. |

Two rules on top of the key:

- **Deduplicate, do not seal.** Recording "this order is finished" and then ignoring everything further is wrong for on-ramp and for M-Pesa-paid checkout sessions, where a late confirmation legitimately completes an order or session you already saw expire or fail. Make the completion path idempotent instead of unreachable.
- **Make the write and the dedupe atomic.** A unique constraint on `(object_id, event)` in your own store, or an upsert, is the reliable shape. Checking "have I seen this?" and then writing in two steps races against a concurrent retry.

## Responding

```
200 OK
```

An empty body is fine. Nothing in the response body is read.

- **Acknowledge fast.** Verify the signature, write the event somewhere durable, return `2xx`, and do the real work asynchronously. You have 10 seconds.
- **Only return `2xx` once the event is safely recorded.** A `2xx` is an acknowledgement — after it, that delivery is finished forever and there is no way to ask for it again.
- **Return a non-2xx deliberately when you cannot record the event.** That is what buys you a retry. Swallowing an internal error and returning `200` discards the event permanently.
- **Return `401` on a signature mismatch** and do not process the body. It will be retried; that is correct, and a genuine Minisend delivery will verify.
- **Do not redirect.** Redirects are not followed and count as failures.
- **Do not put the endpoint behind auth that would reject Minisend.** There are no credentials to configure on the delivery side — the signature is the authentication.

## Gaps and guarantees

One real gap remains, plus a general caution. Delivery is retried but never guaranteed, so **reconcile your own non-terminal orders and sessions rather than treating the webhook as the only source of truth.**

Expiry events that earlier versions dropped — `offramp.expired` and `onramp.expired` lost when a read expired the order in-band, and `checkout.expired`, which was never emitted at all — are all delivered now. If you built expiry detection from `expires_at` to work around that, it still works and remains a good backstop.

| Gap | Product | What to do |
| --- | --- | --- |
| **An on-ramp order that fails at creation emits nothing.** The payment prompt could not be sent, the order is already `failed`, and the response carries no `order_id`. | On-ramp | The `502` on the create call is your only signal. Retry with a **new** `Idempotency-Key`. |
| **The wallet API emits no events.** | Wallets | Everything you need is in the response to the call you made. |

## Common mistakes

- **Verifying against `JSON.stringify(parsedBody)`.** Different bytes, different digest, never verifies. Read the raw body and parse it afterwards.
- **Using the global JSON body parser on the webhook route.** `express.json()`, `request.json`, and friends consume the raw body. Mount a raw parser on that route.
- **Comparing signatures with `==`.** Use `timingSafeEqual` / `hmac.compare_digest` / `hmac.Equal`.
- **Calling `timingSafeEqual` without a length check.** It throws on unequal lengths, turning a bad signature into a 500 and a pointless retry.
- **Looking for a `sha256=` or `t=…,v1=…` prefix.** The header is the bare lower-case hex digest.
- **Expecting a timestamp or event-id header.** There are none. Dedupe from the payload.
- **Deduplicating on `order_id` alone in on-ramp.** One order emits `onramp.released` as well as a status event, and can emit `onramp.expired` then `onramp.completed`. Key on `order_id` plus `event`.
- **Assuming `onramp.released` comes after `onramp.completed`.** No ordering is guaranteed.
- **Sealing an order or session on `failed` or `expired`.** On-ramp orders and M-Pesa-paid checkout sessions can still complete afterwards.
- **Booking revenue from `amount_usdc` on `checkout.completed`.** It is the expected amount, not the amount received. Use `amount_received_usdc`.
- **Returning `200` from a `catch` block.** The event is gone. Return a non-2xx so it is retried.
- **Doing the work before responding.** You have 10 seconds; a slow handler turns successes into retries and duplicates.
- **Registering a URL that redirects.** Redirects are not followed.
- **Pointing the URL at `localhost` or a private address.** It is rejected at save time, and refused without retry at send time.
- **Skipping verification because the signature header was missing.** That means no secret is configured — fix the configuration.
