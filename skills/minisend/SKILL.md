---
name: minisend
description: Integrate Minisend payment APIs — accept USDC/USDT and pay out local currency across Africa. Use when working with Minisend, or when building stablecoin payouts or collections in Kenya, Nigeria, Ghana, or Uganda — M-Pesa, mobile money, paybill, till, or bank transfer; KES, NGN, GHS, UGX; off-ramp, on-ramp, checkout, payment links, or programmatic wallet creation.
---

# Minisend

## What Minisend does

Minisend moves money between stablecoins and local currency across Kenya, Nigeria, Ghana, and Uganda. A business holding USDC or USDT can pay it out as KES, NGN, GHS, or UGX to a bank account, mobile money account, paybill, or till (off-ramp), or accept a customer's stablecoin payment through a hosted checkout page that settles to the business's own bank or mobile money account (checkout). A business can also collect **KES only** from a customer's phone, via an M-Pesa or Airtel Money payment prompt, and receive stablecoins in exchange (on-ramp) — or provision stablecoin wallets programmatically for its own users (wallets).

The two directions do not share a method list. Paybill, till, and bank transfer are off-ramp *payout* destinations; on-ramp collects through the phone prompt and nothing else.

## Pick your product

| You want to | Product | Read |
| --- | --- | --- |
| Pay someone in KES, NGN, GHS, or UGX from a USDC balance | Off-ramp | `references/offramp.md` |
| Collect KES via an M-Pesa or Airtel Money prompt and receive USDC | On-ramp | `references/onramp.md` |
| Create wallets for your own users | Wallets | `references/wallets.md` |
| Accept a payment and settle to a bank or mobile money account | Checkout | `references/checkout.md` |

## Authenticate

Every request carries an API key as a bearer token:

```
Authorization: Bearer <key>
```

Minisend issues two key namespaces, and they are not interchangeable:

- `ms_live_...` — off-ramp, on-ramp, and checkout
- `wsk_live_...` — the wallet API only

```bash
curl https://merchant.minisend.xyz/api/merchant/checkout \
  -H "Authorization: Bearer ms_live_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

Full detail — scopes, the access-gate 403 model, rate limits, error bodies, and how to get access — is in `references/authentication.md`. Read it before writing any request code.

## Rules that prevent most integration bugs

- A key's scope and the account's capability are two independent gates, but both return the identical 403 message — you cannot tell which one failed from the response. Either way, the fix is the same: contact `info@minisend.xyz`.
- Phone numbers are normalised to the local `0XXXXXXXXX` format *for* you — several input shapes are accepted, so read the normalised value back rather than assuming yours survived.
- `refund_address` is mandatory on every off-ramp order.
- **No quote is a lock.** The quote endpoints reserve nothing and the order is priced fresh at creation, so read the priced fields back from the response you actually act on — never compute or hardcode them.
- Webhook signatures verify over the raw request body, not a re-serialized copy of the parsed JSON.

## Reference map

- `references/authentication.md` — API keys, scopes, the access-gate 403 model, rate limits, error bodies
- `references/offramp.md` — pay out KES, NGN, GHS, or UGX from a stablecoin balance
- `references/recipients.md` — recipient formats and validation per currency and method
- `references/onramp.md` — collect KES via an M-Pesa or Airtel Money prompt and receive stablecoins
- `references/wallets.md` — programmatic wallet creation for your own users
- `references/checkout.md` — hosted checkout and payment links
- `references/webhooks.md` — event types, signature verification, delivery/retry behavior
- `references/errors.md` — every error code and body the API returns
- `references/faq.md` — common integration questions
