# FAQ

Questions builders ask that don't have an obvious home in an endpoint reference. Each answer links to the reference that goes deeper — read this file for orientation, not as the source of truth.

## Is there a sandbox or test environment?

No, for any of the four products. The wallet API once recognised a `wsk_test_` prefix, but it never worked end to end — no key-issuing path produced one and no chain could be activated in test mode — and it has since been withdrawn, so such a key now fails as invalid. The merchant products (`ms_live_`) have no test namespace either. Build against small real amounts on live endpoints; see `references/wallets.md` (No test mode) and `references/authentication.md` for the key namespaces.

## What's the difference between checkout, off-ramp, and on-ramp?

**Checkout** — a customer pays you, and it settles to *your own* configured payout account — except an M-Pesa-paid session, which completes without running a payout leg to that account at all. Use it when you're getting paid and the destination is fixed by your account settings, not by the request. See `references/checkout.md`.

**Off-ramp** — you already hold USDC and want to pay someone else out in local currency, naming a different recipient per order. Use it when you're the one initiating a payout to a third party. See `references/offramp.md`.

**On-ramp** — you charge a customer's phone in local currency and receive USDC yourself. Use it when you want stablecoins in exchange for a local-currency charge, and nobody downstream gets paid out in local currency. See `references/onramp.md`.

Provisioning wallet addresses for your own users is a separate product again, with its own key namespace — see `references/wallets.md`.

## Can I use one API key for everything?

No single key spans both key namespaces. An `ms_live_` key covers checkout, off-ramp, and on-ramp — but only the scopes it was issued with — while wallet creation needs a separate `wsk_live_` key; neither authenticates against the other's endpoints. One `ms_live_` key *can* cover all three merchant products at once if it carries all three scopes, but a key with no scope list recorded at all resolves to `checkout`-only — the likely reason an older key silently fails an off-ramp or on-ramp call. See `references/authentication.md` for the scope model.

## How do I get production access, and how do I get off-ramp or on-ramp enabled?

Since there's no sandbox, getting a live key is the whole "going to production" step. The dashboard lets you self-serve a `checkout`-scoped `ms_live_` key immediately — checkout is enabled by default. Off-ramp, on-ramp, and wallet-API access are each opt-in and granted by Minisend on request; contact `info@minisend.xyz`. See `references/authentication.md` (Getting access).

## Why am I getting a 403 when my key looks correct?

Every scoped endpoint checks two things — the key's scope, and whether your account has that product enabled — and both failures return the identical error body by design, so the response never tells you which one is wrong. Don't build logic that tries to distinguish them; the fix is the same either way: contact `info@minisend.xyz`. A different 403 — `Merchant account not found or inactive` (`Tenant account not found or inactive` on the wallet API) — means the whole account is inactive rather than one product being gated, with the same remedy. See `references/authentication.md` and `references/errors.md` for the full 403 model.

## Which chains and assets can a customer pay with?

For checkout, USDC on Base always works, and always settles. An account can also accept USDC on a per-account subset of `ETH`, `ARB`, `OP`, `MATIC`, `AVAX` (read `accepted_chains` off the session, don't hardcode it) — but `accepted_chains` only means "not outright rejected," not "guaranteed to settle": a deposit on a chain outside the set fails with no webhook, and one on an accepted-but-unswept chain can park at `deposit_received` indefinitely. The hosted checkout page additionally accepts USDT and a wider chain set by normalising it to USDC on Base before matching, plus M-Pesa in Kenya via the two M-Pesa endpoints (KES, `Safaricom`/`Airtel` only). Off-ramp deposits and on-ramp releases are USDC on Base only. See `references/checkout.md` (What the customer can pay with).

## Which countries and payout methods are supported?

Off-ramp pays out KES (mobile money, till, paybill, or bank transfer — Kenya), GHS (mobile money — Ghana), UGX (mobile money — Uganda), and NGN (bank transfer only — Nigeria). On-ramp only collects KES, via M-Pesa and Airtel Money in Kenya. See `references/recipients.md` for the full method matrix and `references/onramp.md` for on-ramp's KES-only scope.

## What are the limits per currency and per transaction?

Off-ramp has a 0.5–50,000 USDC per-order band plus a local-currency band per currency (KES, GHS, UGX are rejected pre-order if outside it; NGN isn't pre-checked). On-ramp's floor is 100 KES *net* — not the gross the customer is charged — up to 250,000 KES. Checkout's payment-link path caps at $10,000 USDC; the authenticated create path has a higher ceiling that the error response reports directly rather than a fixed number to hardcode. Quote first rather than precomputing bounds, since the bands are in local currency and move with the rate. See `references/offramp.md` (Limits), `references/onramp.md` (Limits), and `references/checkout.md` (`POST /api/merchant/checkout`).

## How long does settlement take, and what determines it?

There's no fixed duration to plan around, and it differs by product and path. On off-ramp, the KES/GHS/UGX path doesn't move past `pending` until *you* submit the deposit hash — the clock is on you, not Minisend; the NGN path detects the deposit automatically. For a stablecoin-paid checkout session, once the deposit is accounted for the session moves to `settling` and finishes when the payout provider confirms; an M-Pesa-paid checkout session skips `settling` entirely and completes directly once the collection is confirmed. On-ramp has no `settling` state at all — an order goes straight from `pending` to an end state, and the on-chain release (`release_tx_hash`) is recorded independently of that transition, sometimes before it and sometimes after. Wait for the webhook rather than assuming a duration; see `references/offramp.md` (The two deposit paths), `references/checkout.md` (Session lifecycle), and `references/onramp.md` (Order lifecycle).

## Who pays the fee, and what will the recipient actually receive?

The model differs per product and no figures are quoted here — contact `info@minisend.xyz` for current rates. On off-ramp, quote `recipient_amount` and show that to your user; it's the authoritative pre-send figure. On on-ramp the fee is added on top of what converts to USDC, so the customer's phone is always prompted for more than your target `amount_usdc`. On checkout, the payment-link path grosses the charge up so the fee rides on top; the authenticated-create path takes the fee out of the payout side instead. See `references/offramp.md` (Fees), `references/onramp.md` (Fees), and `references/checkout.md` (Settlement).

## Why did the recipient receive less than my quoted amount?

On the off-ramp KES/GHS/UGX path, the order is priced again the moment the payout actually releases — so the settled economics on `offramp.completed` (`amount_local` minus `fee`) can differ from the `recipient_amount` you saw at quote or order-creation time. `recipient_amount` isn't stored on the order or included in the webhook, so it's never the number to reconcile against after the fact. See `references/offramp.md` (Which figure to show, and when).

## What happens when a payout fails? Where do the funds go?

On off-ramp, a failed order sends your deposited USDC back to the `refund_address` you supplied at order creation — it's required on every order for exactly this reason. Checkout has no equivalent refund path or field; a stablecoin deposit that can't settle (for example landing on a chain your account doesn't accept) is a support matter rather than an automatic return. See `references/offramp.md` (`POST /api/offramp/orders`) and `references/checkout.md` (What the customer can pay with).

## What happens if a customer underpays or overpays a checkout session?

It still completes. Checkout matches an incoming deposit to a session by address and amount with about a cent of slack. What happens when nothing matches depends on how many sessions are open on that address: with exactly one open, the deposit is attributed to it and that session settles for whatever actually arrived — there's no partial-payment state. With two or more open, the payment is **not** attributed to any of them; it is held for manual review by Minisend, no session changes status, and no webhook fires. `amount_usdc` on `checkout.completed` is always the originally expected figure, never the amount received, so don't book revenue from it. This matching is checkout-specific; off-ramp and on-ramp amounts are fixed at order creation and aren't subject to it. See `references/checkout.md` (Quote the exact amount) and `references/webhooks.md` (The reconciliation hazard).

## Will I get a webhook when an order or session expires?

Yes, on all three: `checkout.expired`, `offramp.expired`, and `onramp.expired` are all delivered. Earlier versions had gaps here — `checkout.expired` was declared but never emitted, and polling an off-ramp or on-ramp order past its `expires_at` expired it in-band and cost you the event — and all of them are closed: the in-band expiry paths now deliver the event themselves. Delivery is still retried rather than guaranteed, so reconciling your own non-terminal orders and sessions on a timer remains a sound backstop. See `references/webhooks.md`.

## Are terminal statuses really terminal?

It varies by product, so don't reuse one product's assumption on another. Off-ramp's `completed`, `failed`, and `expired` are genuinely immutable. Checkout's `expired` is terminal for a stablecoin payment but not for an M-Pesa one — a late confirmation can still complete it — and `failed` should be treated as terminal for your own flow control even though it isn't formally sealed. On-ramp is the least final: only `completed` is strictly immutable, and a late confirmation can move `failed` or `expired` all the way to `completed`. See the lifecycle sections of `references/offramp.md`, `references/checkout.md`, and `references/onramp.md`.

## How do I deduplicate webhook deliveries?

Key on the object's identifier *and* the event name together, not the identifier alone. On-ramp and checkout both legitimately emit more than one distinct event for the same order or session — an identifier-only key silently drops the second one as a duplicate. See `references/webhooks.md` (Idempotency).

## Do webhook deliveries always arrive signed?

Only if a webhook secret is configured on your account. With none set, deliveries still arrive, just with no `X-Minisend-Signature` header — treat that as a configuration gap to close, not a case your verification code should special-case or skip. See `references/webhooks.md` (The secret).

## How do I test webhooks locally?

Point the dashboard's webhook URL at a public HTTPS tunnel to your machine. `localhost` and other private or loopback addresses are rejected both when you save the URL and again at send time, so there's no way to receive a delivery straight to your laptop without one. See `references/webhooks.md` (Setup).
