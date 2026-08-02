# Authentication

## Two key namespaces

Minisend issues two kinds of API key, and they are not interchangeable:

| Prefix | Unlocks |
| --- | --- |
| `ms_live_...` | Off-ramp, on-ramp, and checkout |
| `wsk_live_...` | The wallet API only |

A `wsk_` key will not authenticate against off-ramp, on-ramp, or checkout endpoints, and an `ms_live_` key will not authenticate against the wallet API.

## Header format

Every request carries the key as a bearer token:

```
Authorization: Bearer <key>
```

```bash
curl https://merchant.minisend.xyz/api/merchant/checkout \
  -H "Authorization: Bearer ms_live_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

## Scopes on `ms_live_` keys

An `ms_live_` key carries one or more scopes: `checkout`, `offramp`, `onramp`. A key with no scope recorded behaves as `checkout` only — this is the default for keys issued before scopes existed, not a way to get broader access.

## The access-gate model

Every scoped endpoint (`checkout`, `offramp`, `onramp`) is gated twice: the key must carry the required scope, **and** the account must have that product enabled. Both have to pass.

The two checks fail with the **same** 403 body — this is deliberate, so the response can't be used to probe which layer is missing:

```json
{ "error": "Your account doesn't have checkout access yet. Please contact info@minisend.xyz to request access." }
```

(`checkout` is substituted with `off-ramp` or `onramp` depending on which scope the endpoint requires.)

A 403 here does not tell you whether the key is missing its scope, the account's capability is off, or both — you cannot diagnose which from the response. The remedy is identical either way: contact `info@minisend.xyz` to request access. Don't build logic that assumes you can distinguish the two cases from the error body.

The defaults behind this gate are deliberately asymmetric:

- **checkout is opt-out** — enabled by default on every account. The gate exists so Minisend can disable a specific account (for example, abuse or fraud), not to hold new accounts back from a product they already have.
- **off-ramp and on-ramp are opt-in** — disabled by default until Minisend explicitly enables them for your account.

## Wallet keys are live-only

There is no test namespace on the wallet API. `wsk_live_` is the only prefix issued and the only one accepted. A `wsk_test_` prefix was recognised by earlier versions but never functioned end to end, and has been withdrawn; a key carrying it now fails with the same invalid-key response documented below, indistinguishable from an unknown key.

See `references/wallets.md` for what to do instead of a sandbox.

## Rate limiting

There are two layers, and both return 429.

**General limit**, applied to every request to a key-protected endpoint: 60 requests per 60 seconds, **keyed by calling client (IP), not by key**. It is checked *before* the `Authorization` header is read, so requests carrying a bad key or no key at all count against the same budget — you cannot dodge it by rotating keys, and every process behind one egress IP shares one allowance. (The public endpoints that take no key are outside this limit; they carry their own per-IP limits, listed in `references/checkout.md`.) There is no proactive allowance signal on a successful response — `X-RateLimit-Remaining` is only attached to the 429 below, so you cannot read it ahead of time to throttle preemptively; track your own request rate client-side instead.

```json
{ "error": "Rate limit exceeded" }
```

**Per-account creation limits**, on top of the general limit, apply to specific order- and session-creation endpoints — each of these calls triggers real downstream work (a payout, an M-Pesa prompt), so they're capped tighter and scoped to your account rather than to the general client identifier:

| Endpoint | Limit | Window |
| --- | --- | --- |
| Create checkout session | 30 | 1 minute |
| Create off-ramp order | 20 | 1 minute |
| Submit off-ramp deposit | 20 | 1 minute |
| Create on-ramp order | 10 | 1 minute |

Each has its own message, all following the same shape, for example:

```json
{ "error": "Too many checkout sessions created recently. Please slow down, or contact info@minisend.xyz if you need a higher limit." }
```

The off-ramp order, off-ramp deposit, and on-ramp order variants read "Too many off-ramp orders created recently...", "Too many deposit submissions recently...", and "Too many onramp orders created recently..." respectively, each followed by the same "Please slow down, or contact info@minisend.xyz if you need a higher limit." remedy.

**On-ramp additionally caps by the paying customer's phone number**, independent of which account or key is calling: 5 requests per 10 minutes to the same phone number. In on-ramp, the phone belongs to the customer paying in local currency — not the party receiving value, who is the integrator, at their own wallet address.

```json
{ "error": "Too many payment requests sent to this phone number recently. Please wait before retrying." }
```

This exists because every on-ramp order fires a real M-Pesa prompt at that phone — the cap protects the customer from being spammed with prompts regardless of which account is initiating them.

## 401 — missing or invalid key

Missing or malformed `Authorization` header (merchant API — off-ramp, on-ramp, checkout):

```json
{ "error": "Missing or invalid Authorization header. Expected: Bearer ms_live_..." }
```

Missing or malformed `Authorization` header (wallet API):

```json
{ "error": "Missing or invalid Authorization header. Expected: Bearer wsk_live_..." }
```

Key not found, revoked, or otherwise invalid (both APIs, same message):

```json
{ "error": "Invalid API key" }
```

## 403 — inactive account

Distinct from the access-gate model above, this fires when the key is valid but the account behind it is inactive.

Merchant API:

```json
{ "error": "Merchant account not found or inactive" }
```

Wallet API:

```json
{ "error": "Tenant account not found or inactive" }
```

## Getting access

The dashboard lets you self-serve a `checkout`-scoped key. Off-ramp, on-ramp, and wallet-API access are each granted by Minisend on request — contact Minisend support to have a scope or capability enabled for your account.

## Key handling

Keys are shown once, at creation, and stored in a form that cannot be reversed back into the original key. If a key is lost, there is no way to recover it — revoke it and create a new one.
