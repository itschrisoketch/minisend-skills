# Wallets

## What it does

The wallet API creates and looks up stablecoin wallet addresses for your own end users, programmatically. You call it with your own identifier for a user — their user ID, an account number, whatever you already use — and get back an EVM address on a chain you have activated.

It is a **separate product** from off-ramp, on-ramp, and checkout. It has its own key namespace, its own account model, and its own tiering. Nothing here converts between stablecoins and local currency: there is no quote, no order, no payout, and no currency anywhere in the API. If you need local-currency conversion, that is `references/offramp.md` and `references/onramp.md`, and it is driven by a different key.

Base URL: `https://merchant.minisend.xyz`

## Requirements

- A `wsk_live_` key. These are **issued separately** from the `ms_live_` keys used by off-ramp, on-ramp, and checkout, and the two are not interchangeable in either direction — an `ms_live_` key will not authenticate here, and a `wsk_` key will not authenticate against the other products. See `references/authentication.md`.
- **At least one activated chain on your account.** Wallet creation fails until a chain is activated, and activation is not something this API can do — see [Chains and tiers](#chains-and-tiers).

**Rate limits.** The general limit applies: 60 requests per 60 seconds, per calling client, keyed by IP rather than by key. `X-RateLimit-Remaining` is attached only to the 429 response, so you cannot read it ahead of time to throttle preemptively.

```json
{ "error": "Rate limit exceeded" }
```

Unlike off-ramp and on-ramp order creation, wallet creation carries **no additional per-account cap** — the general limit is the only one.

**There are no webhook events on this API.** Nothing is delivered when a wallet is created. Everything you need comes back in the response to the call you made.

## No test mode

**There is no sandbox on this API.** Keys are live-only: the only prefix issued or accepted is `wsk_live_`, and every address you create is a real address on mainnet.

A `wsk_test_` prefix was recognised by earlier versions of the authenticator, but it never worked end to end — no route could mint such a key and no chain could be activated in test mode — and it has since been withdrawn rather than left implying a sandbox that does not exist. A key carrying it now fails as an invalid key.

Build against small real amounts. A throwaway `walletRef` prefix (`sandbox:user_1`) keeps your experiments easy to identify later. If a sandbox would block your integration, tell Minisend — it helps them prioritise.

The `mode` field on every wallet object reads `"live"`.

## Endpoint reference

All requests use `Content-Type: application/json` and `Authorization: Bearer wsk_live_…`.

**Note the casing asymmetry.** Request bodies are camelCase (`walletRef`). Response bodies are snake_case (`wallet_ref`). This is not a typo in either direction, and it is the single most common source of a rejected request here — a snake_case request body fails the `walletRef is required` check.

### The wallet object

Every endpoint returns the same object:

```json
{
  "id": "9c1f7c62-52c3-4a0d-9f4e-1b7a0d3e8c11",
  "tenant_id": "3a7d8e11-64bb-4c02-9f10-2e5b7a9c4d33",
  "master_wallet_id": "d4b2f907-1c65-4f8e-b0a3-77c6e2d51908",
  "wallet_ref": "user_8842",
  "address": "0x1234567890abcdef1234567890abcdef12345678",
  "chain": "BASE",
  "status": "active",
  "mode": "live",
  "metadata": { "plan": "pro" },
  "created_at": "2026-07-31T10:30:00.000Z"
}
```

| Field | Notes |
| --- | --- |
| `id` | Minisend's identifier for the wallet. **This is the value the single-wallet path takes** — not `wallet_ref`. |
| `tenant_id` | Your account's identifier. The same on every wallet on your account. |
| `master_wallet_id` | The chain container this wallet belongs to (see [Chains and tiers](#chains-and-tiers)). Every wallet created on a given chain shares one. Nullable — wallets created through this API today always carry it, but treat it as optional rather than assuming a value. |
| `wallet_ref` | The `walletRef` you sent, unchanged. |
| `address` | The EVM address, **lower-cased**. Compare case-insensitively; don't assume the checksum casing you may be used to elsewhere. |
| `chain` | One of the six identifiers in [Chains and tiers](#chains-and-tiers). |
| `status` | `active` or `frozen`. Read-only — there is no endpoint on this API that changes it. |
| `mode` | Always `"live"`. See [No test mode](#no-test-mode). Retained for compatibility; it has no other value. |
| `metadata` | The object you sent, or `null` if you sent none. |
| `created_at` | ISO 8601 timestamp. |

**Keys are always present.** An unset `metadata` comes back as `null`, not omitted — same convention as the off-ramp and on-ramp order objects. Test it with `=== null` or for truthiness; `'metadata' in wallet` always answers `true` and tells you nothing.

The fields above are the complete response. The API serialises wallets through a field allow-list, so internal columns are not exposed — but keep treating anything you see that is not documented here as internal, and do not build on it.

The object is **immutable after creation** through this API. There is no update, no delete, and no way to change `metadata`, `chain`, or `status` once the wallet exists.

### `POST /api/v1/wallets`

Creates a wallet — or returns the one that already exists for that `walletRef`.

Request:

```json
{
  "walletRef": "user_8842",
  "chain": "BASE",
  "metadata": { "plan": "pro" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `walletRef` | yes | Your own identifier for the user. Character rules in [The `walletRef` rule](#the-walletref-rule). |
| `chain` | no | One of `BASE`, `MATIC`, `ARB`, `OP`, `ETH`, `AVAX`. **Defaults to `BASE`** when omitted. Must already be activated on your account. |
| `metadata` | no | An arbitrary JSON **object**. Arrays and `null` are rejected; only an object passes. Stored and returned as sent. |

Response `201`: `{ "wallet": { … } }` — the wallet object above.

**Three things about this call that will catch you out:**

1. **It is create-or-get, not create.** Calling it twice with the same `walletRef` never produces a second address; the second call returns the first wallet. This is the intended way to use it — you can call it on every login without checking first.

2. **The status code is `201` either way.** A brand-new wallet and a returned existing one are indistinguishable by status code. If you need to know which happened, compare `created_at`, or track it yourself.

3. **`chain` and `metadata` are ignored when the wallet already exists.** They are only read on the call that actually creates it. Posting `user_8842` on `BASE` and later posting `user_8842` on `ETH` returns the original `BASE` wallet with the original metadata, with no error and no indication that your input was dropped. **A `walletRef` maps to exactly one wallet on exactly one chain, forever.** If you need a user to have an address on two chains, give each one its own `walletRef` (`user_8842:base`, `user_8842:eth` — the colon is a permitted character).

Errors:

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `{ "error": "Invalid JSON body" }` | Body wasn't valid JSON. |
| `400` | `{ "error": "walletRef is required: 1-128 chars, letters/numbers/_/:/./- only" }` | Missing, empty, not a string, too long, or containing a disallowed character. |
| `400` | `{ "error": "chain must be one of BASE, MATIC, ARB, OP, ETH, AVAX" }` | `chain` was present but not one of the six, including a correct name in the wrong case. |
| `400` | `{ "error": "metadata must be a JSON object" }` | `metadata` was a string, number, array, or `null`. |
| `400` | `{ "error": "No active master wallet for Base — activate this chain before creating wallets on it." }` | The chain is valid but not activated on your account. See [Chains and tiers](#chains-and-tiers). |
| `401` / `403` | See `references/authentication.md`. | Key or account problem. |
| `429` | `{ "error": "Rate limit exceeded" }` | General limit. |
| `500` | `{ "error": "Failed to create wallet" }` | The wallet could not be provisioned. Retry with the same `walletRef` — the call is create-or-get, so a retry after a dropped response cannot produce a duplicate address. |

Note that the chain-not-activated case is a `400`, not a `403`, even though it is an account-state problem rather than a malformed request.

### `GET /api/v1/wallets`

Lists the wallets on your account, **newest first** by creation time.

| Parameter | Default | Notes |
| --- | --- | --- |
| `limit` | `20` | Capped at 100 server-side. |
| `offset` | `0` | Where the page starts. |

Response `200`:

```json
{
  "wallets": [
    {
      "id": "9c1f7c62-52c3-4a0d-9f4e-1b7a0d3e8c11",
      "tenant_id": "3a7d8e11-64bb-4c02-9f10-2e5b7a9c4d33",
      "master_wallet_id": "d4b2f907-1c65-4f8e-b0a3-77c6e2d51908",
      "wallet_ref": "user_8842",
      "address": "0x1234567890abcdef1234567890abcdef12345678",
      "chain": "BASE",
      "status": "active",
      "mode": "live",
      "metadata": null,
      "created_at": "2026-07-31T10:30:00.000Z"
    }
  ],
  "total": 214,
  "limit": 20,
  "offset": 0
}
```

Each element is a **complete wallet object** — the same shape the single-wallet endpoint returns. No follow-up fetch needed.

`total` is the count of all wallets on your account, not the page. Paginate by advancing `offset` by `wallets.length` until it reaches `total`.

**The echoed `limit` and `offset` are the values actually applied**, not the ones you sent. Ask for `limit=500` and both the page and the echoed `limit` come back as `100`. A negative or non-numeric value falls back to the default (`20` for `limit`, `0` for `offset`) and the echo reports that fallback. Paging off `wallets.length` is still the most robust loop, but the echoed value is now safe to trust.

There is no filter parameter — no filtering by chain, by status, or by `wallet_ref`.

### `GET /api/v1/wallets/{wallet_id}`

Response `200`: `{ "wallet": { … } }`.

**The path segment is the wallet's `id`, not its `wallet_ref`.**

`id` is a UUID. The endpoint's behaviour splits on whether what you pass *is* one:

| What you pass | What you get |
| --- | --- |
| A UUID that is a wallet on your account | `200` and the wallet object |
| A UUID that is unknown, or is on another account | `404 { "error": "Wallet not found" }` |
| Anything that is not a UUID — a `walletRef`, a numeric ID, a truncated UUID | `404 { "error": "Wallet not found" }` |

**A `404` branch does catch "that was a ref, not an id".** The value is screened before the lookup, so a malformed id is reported as not-found in the normal JSON error shape rather than as a server error. Earlier versions returned a `500` with a body that was not guaranteed to be JSON; if you wrote a defensive non-JSON parse for this endpoint, it is no longer needed (though it does no harm).

The `404` deliberately does not distinguish an unknown wallet from one on another account.

**There is no lookup-by-`walletRef` endpoint.** Since `walletRef` is your own identifier, the intended pattern is to call `POST /api/v1/wallets` with it again: it returns the existing wallet rather than creating a second one, which makes it a safe idempotent read — and it avoids the failure mode above entirely. Store the returned `id` alongside your user record if you would rather not.

## The `walletRef` rule

`walletRef` must match:

```
1 to 128 characters, from: A-Z a-z 0-9 _ : . -
```

Nothing else passes. In particular these all fail with `400`:

- **Spaces** — `"user 8842"`.
- **`@`** — so a raw email address is rejected. Hash it, or use your internal user ID.
- **`/`, `+`, `#`, `%`, and every other punctuation mark** outside the four permitted ones.
- **Non-ASCII characters**, including accented letters and emoji.
- **The empty string**, and any non-string JSON value (number, boolean, array, object, `null`).

```json
{ "error": "walletRef is required: 1-128 chars, letters/numbers/_/:/./- only" }
```

Practical guidance:

- **It is scoped to your account.** Another account using `user_1` does not collide with yours.
- **It is not scoped by mode or by chain.** One `walletRef` means one wallet for your whole account. Namespace it yourself if you need more than one wallet per user — `user_8842:base` and `user_8842:eth`.
- **UUIDs, numeric IDs, and prefixed IDs pass unchanged**, which is the point: pass your own user identifier straight through rather than inventing a mapping.
- **Choose it once and never rewrite it.** It is the only handle that reliably resolves back to a wallet without you storing anything, and there is no rename.

## Chains and tiers

### The chain identifiers

Six chains, upper-case, exactly as written:

| Identifier | Network |
| --- | --- |
| `BASE` | Base |
| `MATIC` | Polygon |
| `ARB` | Arbitrum |
| `OP` | Optimism |
| `ETH` | Ethereum |
| `AVAX` | Avalanche |

**The casing is exact and the identifiers are not the network names.** `base`, `Base`, `polygon`, `arbitrum`, and `ethereum` are all rejected with:

```json
{ "error": "chain must be one of BASE, MATIC, ARB, OP, ETH, AVAX" }
```

Omitting `chain` entirely defaults to `BASE`.

### Tiers

Your account carries a tier, which decides which chains you are eligible to activate:

| Tier | Chains |
| --- | --- |
| `free` | `BASE` only |
| `premium` | All six |
| `enterprise` | All six |

`premium` and `enterprise` have **identical** chain eligibility today; the two are kept distinct for future differentiation. Do not write logic that expects `enterprise` to unlock a chain `premium` does not.

The number of chains you can have activated at once is the size of your tier's set — one for `free`, six for the other two. In other words the tier limits *which* chains, not how many of the allowed ones you use.

### Activation, and the error when you skip it

Each chain you use is activated once for your account, which provisions a single container for it — the error messages call this the **master wallet** for that chain. Every wallet subsequently created on that chain is grouped under it, and the wallet object reports which one through `master_wallet_id`.

**Activation is done from the Minisend dashboard. There is no activation endpoint on this API** — this is deliberate, so activation stays an explicit account-level action rather than something a stray API call performs for you.

Create a wallet on a chain you have not activated and you get:

```json
{ "error": "No active master wallet for Base — activate this chain before creating wallets on it." }
```

The network's display name is substituted — `Base`, `Polygon`, `Arbitrum`, `Optimism`, `Ethereum`, `Avalanche` — so the message text varies by chain. **Match on the status code and the shape, not on the string.**

What to do about it:

1. Activate the chain in the dashboard, then retry. The retry is safe — nothing was created by the failed call.
2. If the chain isn't offered to you there, your tier doesn't allow it. Contact Minisend at `info@minisend.xyz`.

Because activation cannot be automated through the API, treat it as a **deployment prerequisite**, not a runtime condition: activate every chain you intend to use before your integration goes live, rather than writing code that catches this error and recovers.

## Worked example

Provisioning a deposit address per user, and looking it up again later.

```ts
const BASE_URL = 'https://merchant.minisend.xyz'
const KEY = process.env.MINISEND_WALLET_KEY // wsk_live_… — NOT your ms_live_ key
if (!KEY) throw new Error('MINISEND_WALLET_KEY is not set')

const headers = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
}

type Wallet = {
  id: string
  wallet_ref: string
  address: string
  chain: 'BASE' | 'MATIC' | 'ARB' | 'OP' | 'ETH' | 'AVAX'
  status: 'active' | 'frozen'
  metadata: Record<string, unknown> | null
  created_at: string
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  })
  // Don't assume an error body is JSON — a 500 from this API may not be.
  const raw = await res.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error(`${res.status} ${raw.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = (body as { error?: string }).error
    throw new Error(`${res.status} ${err ?? raw.slice(0, 200)}`)
  }
  return body as T
}

// 1. Create the wallet. Safe to call on every login: create-or-get on
//    walletRef, so a repeat call returns the same address rather than
//    minting a second one. Note walletRef is camelCase on the way in and
//    comes back as wallet_ref.
const { wallet } = await call<{ wallet: Wallet }>('/api/v1/wallets', {
  method: 'POST',
  body: JSON.stringify({
    walletRef: 'user_8842',        // 1-128 chars: letters, numbers, _ : . -
    chain: 'BASE',                 // exact upper-case; omit for BASE
    metadata: { plan: 'pro' },     // must be an object, or omitted
  }),
})

// address is lower-cased — compare case-insensitively.
console.log(wallet.address, wallet.chain)

// 2. Look it up later. The path takes wallet.id (a UUID), NOT wallet_ref —
//    interpolating a ref here returns 404, not the wallet you wanted.
const fetched = await call<{ wallet: Wallet }>(`/api/v1/wallets/${wallet.id}`)
console.log(fetched.wallet.status)

// 3. If you didn't store the id, POST the same walletRef again — it returns
//    the existing wallet and creates nothing.
const again = await call<{ wallet: Wallet }>('/api/v1/wallets', {
  method: 'POST',
  body: JSON.stringify({ walletRef: 'user_8842' }),
})
console.log(again.wallet.id === wallet.id) // true

// 4. Page through every wallet on the account. Page off wallets.length; the
//    server caps `limit` at 100 and echoes the value it actually applied.
async function* allWallets() {
  let offset = 0
  for (;;) {
    const page = await call<{ wallets: Wallet[]; total: number; offset: number }>(
      `/api/v1/wallets?limit=100&offset=${offset}`
    )
    yield* page.wallets
    offset += page.wallets.length
    if (page.wallets.length === 0 || offset >= page.total) return
  }
}

for await (const w of allWallets()) {
  console.log(w.wallet_ref, w.address, w.metadata ?? '(no metadata)')
}
```

Activating a chain is a one-time dashboard step, so it belongs in your setup checklist rather than in this code. If you skip it, step 1 fails with a `400` whose message names the network — activate it and re-run.

## Common mistakes

- **Using an `ms_live_` key.** The wallet API only accepts `wsk_` keys, and vice versa. The failure is a plain invalid-key `401` that looks like a typo rather than a namespace error.
- **Sending `wallet_ref` in the request.** The request field is `walletRef`; only the *response* is snake_case. A snake_case request body fails the `walletRef is required` check.
- **Expecting `wsk_test_` to give you a sandbox.** The prefix has been withdrawn and now fails as an invalid key. There is no sandbox. See [No test mode](#no-test-mode).
- **Treating `201` as "created".** Every successful `POST` returns `201`, including one that returned an existing wallet. Compare `created_at` if the distinction matters.
- **Re-posting an existing `walletRef` with a different `chain` or `metadata`.** Both are silently ignored and the original wallet comes back. There is no error to catch and no update endpoint — use a distinct `walletRef` per chain.
- **Putting `walletRef` in the single-wallet path.** `GET /api/v1/wallets/{wallet_id}` takes the wallet's `id`, which is a UUID. A ref returns `404`, which is easy to mistake for a deleted wallet. Re-POST the `walletRef` instead.
- **Sending an email address as `walletRef`.** `@` is not a permitted character.
- **Lower-casing the chain.** `base` is rejected; `BASE` is required. And the identifiers are `MATIC`, `ARB`, `OP`, `AVAX`, not the network names.
- **Catching the chain-not-activated `400` and retrying at runtime.** Activation is a dashboard action that no API call can perform — retrying will fail identically forever. Activate up front.
- **Checksum-comparing `address`.** It is stored lower-cased. Normalise both sides before comparing.
- **Expecting a webhook.** This API emits none.
