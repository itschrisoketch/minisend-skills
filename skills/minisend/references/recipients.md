# Recipients

In off-ramp, the **recipient** is the party receiving the local-currency payout — the phone number, till, paybill, or bank account the money lands in. The recipient is attached to the order, not to your account, so every order can pay a different person.

The `recipient` object is the same shape everywhere it appears: `POST /api/offramp/quote` (optional), `POST /api/offramp/validate-account` (required), and `POST /api/offramp/orders` (required). Get it right once and it works in all three.

See `references/offramp.md` for the endpoints themselves.

## The matrix

Which payout methods each currency supports:

| Currency | `MOBILE` | `BUY_GOODS` (till) | `PAYBILL` | `BANK_TRANSFER` |
| --- | --- | --- | --- | --- |
| KES | yes | yes | yes | yes |
| GHS | yes | no | no | no |
| UGX | yes | no | no | no |
| NGN | no | no | no | yes (implicit — send no `method`) |

`recipient.method` is required and case-normalised to upper case for KES, GHS, and UGX. **NGN takes no `method` field** — it is always a bank transfer, and the API fills the method in for you.

Sending a method a currency doesn't support is rejected before anything is created:

```json
{ "error": "recipient.method is required. Supported for GHS: MOBILE." }
```

## `account_name` is required for every method

Every recipient object, in every currency and every method, must carry `account_name`. There are no exceptions. Omit it and you get:

```json
{ "error": "recipient.account_name is required." }
```

`account_name` is what you believe the account is registered as. For some destinations Minisend can resolve the true registered name — see [Account validation](#account-validation) below — but you always have to supply your own value.

## Required fields per method

### `MOBILE` — mobile money (KES, GHS, UGX)

Fields: `account_name`, `method`, `phone`, `mobile_network`.

```json
{
  "account_name": "Jane Wanjiru",
  "method": "MOBILE",
  "phone": "+254712345678",
  "mobile_network": "Safaricom"
}
```

`phone` is normalised to `0XXXXXXXXX` before use. `mobile_network` is normalised to the canonical value for the currency. Both normalised values are what appear on the order.

### `BUY_GOODS` — till number (KES only)

Fields: `account_name`, `method`, `till`.

```json
{
  "account_name": "Mama Njeri Groceries",
  "method": "BUY_GOODS",
  "till": "123456"
}
```

`till` must be 5–7 digits. Spaces are stripped before the check, so `"12 34 56"` is accepted; any other non-digit character is not.

### `PAYBILL` — paybill number plus account (KES only)

Fields: `account_name`, `method`, `paybill`, `paybill_account`.

```json
{
  "account_name": "Nairobi Water",
  "method": "PAYBILL",
  "paybill": "888880",
  "paybill_account": "ACC-4471"
}
```

`paybill` must be 5–7 digits, spaces stripped, same rule as `till`. `paybill_account` is the free-form account/reference the biller expects and is required.

### `BANK_TRANSFER` — bank account (KES only)

Fields: `account_name`, `method`, `account_number`, `bank_code`; optional `bank_name`.

```json
{
  "account_name": "Jane Wanjiru",
  "method": "BANK_TRANSFER",
  "account_number": "0102030405060",
  "bank_code": "11",
  "bank_name": "Cooperative Bank"
}
```

`bank_name` is optional and passed through as supplied.

### NGN — bank transfer, no `method`

Fields: `account_name`, `institution`, `account_number`; optional `bank_name`.

```json
{
  "account_name": "Chidi Okafor",
  "institution": "GTBINGLA",
  "account_number": "0123456789"
}
```

`institution` is the bank's institution code. If you send `bank_code` instead of `institution`, it is accepted as a synonym — `institution` is read first, `bank_code` is the fallback. Any `method` you send on an NGN recipient is ignored; the order is always recorded as `BANK_TRANSFER`.

## Phone numbers

`phone` is only used by the `MOBILE` method. Whatever you send is stripped of every non-digit character first, then matched against these shapes. All four normalise to the same local `0XXXXXXXXX` value:

| Input shape | Example (KES) | Normalises to |
| --- | --- | --- |
| `+<dial code><9 digits>` | `+254712345678` | `0712345678` |
| `<dial code><9 digits>` | `254712345678` | `0712345678` |
| `0` + 9 digits (10 total) | `0712345678` | `0712345678` |
| 9 digits, no leading zero | `712345678` | `0712345678` |

Because non-digits are stripped first, `+254 712 345 678` and `0712-345-678` are accepted too.

Dial codes per currency: KES `254`, GHS `233`, UGX `256`. (NGN's dial code is `234`, but NGN has no mobile payout method, so you never send a phone for it.)

Anything that doesn't match one of the four shapes is rejected with the currency's own expected format spelled out in the message:

```json
{ "error": "recipient.phone is not a valid KES mobile number (expected e.g. 0XXXXXXXXX or +254XXXXXXXXX)." }
```

Always read the normalised `recipient.phone` back from the order response rather than assuming your input format was preserved.

## Mobile networks

`mobile_network` resolves to an exact, case-sensitive canonical value. These are the canonical values per currency:

| Currency | Canonical networks |
| --- | --- |
| KES | `Safaricom`, `Airtel` |
| GHS | `MTN`, `Vodafone`, `AirtelTigo` |
| UGX | `MTN`, `Airtel` |

Matching is forgiving on the way in: your input is trimmed, lower-cased, and has spaces, underscores, and hyphens removed before it is compared against the canonical list. So `airteltigo`, `Airtel-Tigo`, and `AIRTEL TIGO` all resolve to `AirtelTigo`.

Two aliases are accepted on top of that:

| Currency | Alias you may send | Canonical value stored |
| --- | --- | --- |
| KES | `mpesa` (also `m-pesa`, `M_PESA`, …) | `Safaricom` |
| GHS | `telecel` (also `Telecel`) | `Vodafone` |

Note the GHS one carefully: the network is commonly branded Telecel today, but the canonical value on the order is `Vodafone`. Send either; expect `Vodafone` back.

An unrecognised network is rejected with the valid list in the message:

```json
{ "error": "recipient.mobile_network is not supported for UGX. One of: MTN, Airtel." }
```

## Account validation

`POST /api/offramp/validate-account` resolves a recipient's registered name before you create an order. It takes `currency` and `recipient` (no amount) and returns:

```json
{ "valid": true, "recipient_name": "JANE WANJIRU" }
```

`recipient_name` is `null` when the destination is valid but no name could be resolved. On failure it returns **422**:

```json
{ "valid": false, "error": "Recipient validation failed. Confirm the account details and try again." }
```

### Hard gates versus soft lookups — this determines whether a bad recipient blocks the order

`POST /api/offramp/orders` runs the same validation before creating anything. Whether a validation miss stops the order depends entirely on the destination type:

| Destination | Gate | Effect on order creation |
| --- | --- | --- |
| NGN bank account | **hard** | An unverifiable account returns 422 and no order is created. A valid account with no name available still passes — you just get no `recipient_name`. |
| KES `BANK_TRANSFER` | **hard** | Requires a completed lookup *and* a non-empty registered name. Either missing → 422, no order created. |
| `MOBILE` | **soft** | Best-effort. A name is returned when the lookup succeeds; a failed or unavailable lookup never blocks the order. |
| `BUY_GOODS` | **soft** | Same as `MOBILE`. |
| `PAYBILL` | **soft** | Same as `MOBILE`. |

The practical consequence: **for mobile, till, and paybill destinations, a successful order creation is not proof the number exists.** Name resolution for these is explicitly best-effort and its reliability varies, so a typo in a phone number can survive order creation and only surface as a failed payout. Confirm the number with your own user; don't rely on validation to catch it.

For bank destinations the opposite holds — validation is a real gate, and a 422 there means the account genuinely could not be verified.

`POST /api/offramp/quote` will also run validation, but only if you include a `recipient` in the quote body. When you do, the same 422 applies, and a resolved name comes back as `recipient_name` on the quote.

## Every validation error, verbatim

These come from the request validator and are returned as `400 { "error": "<message>" }` unless noted. An agent that matches the exact string can fix the payload without another round trip.

| Message | Cause |
| --- | --- |
| `Missing recipient object.` | `recipient` absent, `null`, or not an object. |
| `recipient.account_name is required.` | `account_name` missing, not a string, or blank after trimming. Applies to every currency and method. |
| `recipient.institution (bank code) is required for NGN.` | NGN order with neither `institution` nor `bank_code`. |
| `recipient.account_number is required for NGN.` | NGN order with no `account_number`. |
| `recipient.method is required. Supported for <CURRENCY>: <LIST>.` | For KES/GHS/UGX: `method` missing, or not one the currency supports. The message lists that currency's supported methods. |
| `recipient.phone is required for MOBILE.` | `MOBILE` with no `phone`. |
| `recipient.mobile_network is required for MOBILE.` | `MOBILE` with no `mobile_network`. |
| `recipient.phone is not a valid <CURRENCY> mobile number (expected e.g. 0XXXXXXXXX or +<DIAL>XXXXXXXXX).` | `phone` didn't match any accepted shape for that currency's dial code. |
| `recipient.mobile_network is not supported for <CURRENCY>. One of: <LIST>.` | `mobile_network` didn't resolve to a canonical value or accepted alias for that currency. |
| `recipient.till is required for BUY_GOODS.` | `BUY_GOODS` with no `till`. |
| `recipient.till must be 5-7 digits.` | `till` present but, after stripping spaces, not 5–7 digits. |
| `recipient.paybill is required for PAYBILL.` | `PAYBILL` with no `paybill`. |
| `recipient.paybill must be 5-7 digits.` | `paybill` present but, after stripping spaces, not 5–7 digits. |
| `recipient.paybill_account is required for PAYBILL.` | `PAYBILL` with no `paybill_account`. |
| `recipient.account_number is required for BANK_TRANSFER.` | KES `BANK_TRANSFER` with no `account_number`. |
| `recipient.bank_code is required for BANK_TRANSFER.` | KES `BANK_TRANSFER` with no `bank_code`. |

The rest come from the surrounding order body rather than the recipient object, and the same validator returns them, so you hit them in the same place:

| Message | Cause |
| --- | --- |
| `Invalid amount. Must be a positive number (USDC).` | `amount` missing, not a JSON number, not finite, or zero/negative. A numeric *string* fails this too. |
| `Amount below minimum of 0.5 USDC.` | `amount` under the per-order USDC minimum. |
| `Amount exceeds maximum of 50000 USDC.` | `amount` over the per-order USDC maximum. |
| `Invalid currency. Supported: KES, GHS, NGN, UGX.` | `currency` missing or outside the supported set. Compared after upper-casing, so `kes` is fine. |
| `refund_address is required and must be a valid 0x EVM address.` | `refund_address` missing, or not `0x` followed by 40 hex characters. Required on every off-ramp order. |

One more comes from pricing rather than parsing, also as a `400`, and it names the supported band in both local currency and its USDC equivalent at the current rate:

```
Amount converts to <local amount> <CURRENCY>, outside the supported range of
<min>–<max> <CURRENCY> per transaction (≈ <min>–<max> USDC at the current rate).
```

And one from validation rather than parsing:

| Message | Status | Cause |
| --- | --- | --- |
| `Recipient validation failed. Confirm the account details and try again.` | 422 | A hard-gated destination (NGN bank, KES `BANK_TRANSFER`) could not be verified. No order was created. |

## How recipient fields come back

The order response echoes a trimmed projection of the recipient, not everything you sent:

```json
{
  "recipient": {
    "account_name": "Jane Wanjiru",
    "method": "MOBILE",
    "account_number": null,
    "institution": null,
    "phone": "0712345678"
  }
}
```

Exactly five keys appear — `account_name`, `method`, `account_number`, `institution`, and `phone` — and **all five are always present.** The ones that don't apply to the method carry `null`; they are not dropped. The KES mobile order above still has `account_number` and `institution` as `null`, and an NGN bank order still has `phone` as `null`.

So test them for truthiness or against `null`. `'phone' in order.recipient` is `true` on every order regardless of method and will not tell you anything, and `=== undefined` never matches. This matches the order object generally — see the null-versus-absent note in `references/offramp.md`, where `sender_fee_usdc` and `transaction_fee_usdc` are the only genuinely absent fields.

`till`, `paybill`, `paybill_account`, `bank_code`, and `bank_name` are stored and used for the payout but are never echoed back at all — keep your own copy if you need to display them.
