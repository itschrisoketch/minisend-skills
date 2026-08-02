# Minisend skill

Teaches your coding agent to integrate [Minisend](https://minisend.xyz) — accept stablecoin
payments and pay out local currency across Kenya, Nigeria, Ghana, and Uganda.

Works offline. Once installed, the agent has the endpoints, payloads, error shapes, and webhook
rules on hand and does not need to fetch anything.

## Install

Either installer works. Both drop the same files.

    npx skills add itschrisoketch/minisend-skills

    npx @minisend/skill

Installs to `.claude/skills/minisend`, and to `.agents/skills/minisend` when that directory
already exists.

    npx @minisend/skill --dir path/to/skills   # custom location
    npx @minisend/skill --force                # overwrite an existing install

## What it covers

| Product | What it does |
| --- | --- |
| **Off-ramp** | Send USDC, Minisend pays out KES, NGN, GHS, or UGX to a phone, till, paybill, or bank account |
| **On-ramp** | Collect KES by M-Pesa prompt, receive USDC at your own wallet address |
| **Wallets** | Create and look up wallets programmatically |
| **Checkout** | Take a payment and settle it to a local bank or mobile money account |

Plus authentication and key scopes, recipient formats per currency, webhook signature
verification, and every error the API returns.

## Usage

Ask your agent directly:

> Using the minisend skill, add an M-Pesa payout flow to this app.

## Layout

    skills/minisend/SKILL.md          the router — loaded whenever the skill fires
    skills/minisend/references/       nine topic references, loaded on demand

`SKILL.md` stays short on purpose. Each reference is read only when that product is in play.

## Accuracy

Every endpoint, field name, enum value, status code, and limit in these files was read out of the
Minisend API's route handlers rather than from published documentation, then verified a second
time against the same source. Where the API's behaviour is surprising — events that are not
guaranteed to arrive, amounts that report the expected figure rather than the received one,
statuses that are terminal for one product and not another — the references say so.

`npm test` runs three gates:

- **`scripts/test-install.mjs`** — the installer's behaviour, including the conflict guard and
  `--force` clean-mirror semantics
- **`scripts/test-audit.mjs`** — the content rules themselves, against strings that must be caught
  and ordinary prose that must pass
- **`scripts/audit.mjs`** — the shipped payload against those rules

The content rules block infrastructure vendor names, fee figures, regulatory-sensitive claims, and
internal identifiers from reaching the payload. They are commercial and regulatory requirements,
not style preferences.

## Contributing

Run `npm test` before opening a pull request. CI runs the same three gates.

If a reference contradicts the live API, that is a bug worth reporting — open an issue with the
endpoint and what you observed.

## Links

- Documentation: [docs.minisend.xyz](https://docs.minisend.xyz)
- Package: [`@minisend/skill`](https://www.npmjs.com/package/@minisend/skill)

## License

MIT — see [LICENSE](LICENSE).
