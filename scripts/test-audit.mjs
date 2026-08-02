#!/usr/bin/env node
/**
 * Unit tests for the audit rules themselves. The audit script is the
 * compliance gate every later task runs — a rule that silently never fires
 * on realistic input is worse than no rule, so each rule is proven against a
 * must-catch set (real identifiers and phrasings pulled from the parent
 * codebase) and a must-pass set (ordinary prose that must not false-positive
 * on a vendor name as a mere substring).
 */
import { RULES } from './audit.mjs'

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log(`  ok  ${label}`)
  } else {
    console.error(`FAIL  ${label}`)
    failures++
  }
}

function anyRuleMatches(text) {
  return RULES.some((rule) => {
    rule.pattern.lastIndex = 0
    return rule.pattern.test(text)
  })
}

const mustCatch = [
  // Vendor name as a substring of a compound identifier (underscore, not a
  // standalone word) — real field names in the parent codebase.
  'circle_address',
  'circle_wallet_id_base',
  'circle_send_tx_id',
  // Case variants of the internal field name rule.
  'CIRCLE_WALLET_ID',
  'Circle_Wallet_Id',
  'circle_wallet_id',
  // Custody stem beyond the three literal forms the old rule listed.
  'custodians',
  'custodianship',
  // Custody still catches the base forms.
  'custody',
  'custodial',
  'custodian',
  // Active, passive, and third-party-behalf phrasings of funds being held.
  // Each one names a party — "customer", "your", "the merchant" — directly
  // adjacent to the verb, which is exactly the distinction the must-pass
  // set below is checking these rules don't ignore.
  'we hold customer funds',
  'your funds are held by us',
  'Minisend holds the merchant funds until settlement.',
  'The platform holds customer funds until payout.',
  'we are holding your funds',
  'The exchange holds your funds until the trade completes.',
  'Customer funds are held separately from operating capital, per regulation.',
  'funds are held on your behalf',
  "Funds are held on the merchant's behalf until settlement.",
  // Fee/rate figure and other vendor names, unchanged behaviour.
  'a 1% fee applies',
  'Settlement runs through Pretium.',
  'Payouts route through Paycrest.',
  'Backed by Xwift infrastructure.',
]

for (const text of mustCatch) {
  check(`catches ${JSON.stringify(text)}`, anyRuleMatches(text))
}

const mustPass = [
  // "circle" as a substring of an unrelated English word must not trip the
  // vendor-name rule — only compound identifiers and the standalone word
  // should fire.
  'The fence will encircle the property.',
  'Water will circulate through the pipes before it settles.',
  'Ordinary settlement documentation with no vendor names at all.',
  'The recipient receives the full amount with no deductions.',
  // "funds" and a hold/held verb co-occurring is not by itself a custody
  // claim — nothing here names a party as the one whose funds are held, so
  // none of these should trip the custody rules. These are exactly the
  // kind of sentences references/errors.md will contain (Task 7).
  'If insufficient funds are supplied, the session is held in a failed state for 24 hours.',
  'The request fails due to insufficient funds; the retry is held in a queue for 30 seconds.',
  'This field holds a reference used later when funds settle.',
  'Returns a 402 error when the sender has insufficient funds for the payout amount.',
  'The order expires and is held for manual review if funds fail to settle within the timeout.',
  // Second-person API-error prose containing both a hold/held verb and a
  // separate "your funds"/"your payment" mention in the same sentence — a
  // party word (not a proximity gap) is what must gate these, and "your" is
  // the most common second-person word in this register, so this shape is
  // exactly what previously false-positived.
  'Your session is held for 24 hours if your funds transfer fails.',
  'The payout is held in review while your funds clear the network.',
  'Your request is held in the queue because your funds have not yet settled.',
  'The transaction is held pending verification; your funds remain in transit.',
  'Your payment is held for review if your account has unusual activity, and your funds arrive once verification completes.',
  'The system holds your session token separately from your funds balance display.',
  'Your transfer is held in a pending state while your funds settle on-chain.',
  "If your card is declined, your payment is held and your funds are not deducted until you retry.",
]

for (const text of mustPass) {
  check(`does not flag ${JSON.stringify(text)}`, !anyRuleMatches(text))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall audit rule checks passed')
