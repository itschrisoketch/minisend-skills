#!/usr/bin/env node
/**
 * Enforces the content rules on the skill payload. These are not style
 * preferences — shipping a vendor name, a fee figure, or custody language to
 * external builders is a commercial and regulatory problem.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PAYLOAD = join(ROOT, 'skills', 'minisend')
// README.md is not under skill/, but the package.json `files` allowlist ships
// it to npm alongside the payload — so it is read by the same strangers and
// must clear the same content rules.
const EXTRA_SHIPPED_FILES = [join(ROOT, 'README.md')]

// Custody-funds phrasing is matched by exact adjacency, not proximity.
// Two earlier rounds each traded one false-positive class for another by
// widening or narrowing a "how many characters count as nearby" gap: round 1
// allowed any hold/held verb and the bare word "funds" anywhere in the same
// line; round 2 required a party-owned funds phrase but still allowed a
// 30-character gap to the verb, which "your funds" — the most common
// second-person phrase in API docs — tripped constantly whenever an
// unrelated hold/held verb happened to land nearby in the same sentence
// ("your session is held for 24 hours if your funds transfer fails").
// These three rules only match when the verb and the funds phrase are
// directly adjacent (whitespace only between them), so an unrelated
// hold/held verb elsewhere in the sentence no longer fires. The \bcustod\w*
// rule above remains the primary safety net — genuine custody claims in
// payments documentation almost always use the word "custody" or
// "custodial" somewhere; these three are a narrower backstop for the
// phrasings that don't.
const HOLD_PARTY_FUNDS = /\b(hold|holds|holding)\s+(your|our|the\s+)?(customer|merchant|user|client|your)s?'?\s*funds\b/gi
const PARTY_FUNDS_HELD = /\b(your|customer|merchant|user|client)s?'?\s+funds\s+(are|is)\s+held\b/gi
// The middle segment handles both a bare second-person party ("on your
// behalf") and a third-party possessive, with or without a leading "the"
// ("on the merchant's behalf", "on merchant's behalf") — \w+ alone can't
// span the apostrophe in "merchant's", so the possessive is its own branch.
const FUNDS_HELD_ON_BEHALF = /\bfunds\s+(are|is)\s+held\s+(on|in)\s+(?:your|our|their|(?:the\s+)?\w+'s)\s+behalf\b/gi

const RULES = [
  // Vendor names must be caught as a substring of compound identifiers
  // (circle_address, circle_wallet_id_base, circle_send_tx_id are real
  // field names in the parent codebase), not only as a standalone word.
  // The `(?![a-z])` lookahead (case-insensitive, so it also blocks A-Z)
  // stops the match from continuing into another lowercase/uppercase
  // letter — so it still matches "circle_address" (next char "_") and
  // plain "circle" (next char is punctuation/space/end), but does not fire
  // on unrelated English words like "circles" or "circled". The leading
  // \b already excludes "encircle" — there is no word boundary between the
  // "n" and the "c".
  { pattern: /\bcircle(?![a-z])/gi, reason: 'infrastructure vendor name' },
  { pattern: /\bpretium(?![a-z])/gi, reason: 'infrastructure vendor name' },
  { pattern: /\bpaycrest(?![a-z])/gi, reason: 'infrastructure vendor name' },
  { pattern: /\bxwift(?![a-z])/gi, reason: 'infrastructure vendor name' },
  // Catches the custod* stem generally: custody, custodial, custodian,
  // custodians, custodianship, etc. — not just the three literal forms.
  { pattern: /\bcustod\w*/gi, reason: 'custody characterization' },
  // Adjacent custody phrasing, in each phrase order: verb-then-funds ("we
  // hold customer funds", "holding your funds"), funds-then-held ("your
  // funds are held by us"), and the passive third-party form ("funds are
  // held on the merchant's behalf").
  { pattern: HOLD_PARTY_FUNDS, reason: 'custody characterization' },
  { pattern: PARTY_FUNDS_HELD, reason: 'custody characterization' },
  { pattern: FUNDS_HELD_ON_BEHALF, reason: 'custody characterization' },
  { pattern: /\d+(\.\d+)?\s?%/g, reason: 'fee or rate figure' },
  { pattern: /\bcircle_wallet_id\b/gi, reason: 'internal field name' },
  { pattern: /\bsupabase\b/gi, reason: 'internal infrastructure' },
]

async function markdownFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await markdownFiles(full)))
    else if (entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

async function auditPayload(payloadDir, extraFiles = []) {
  const violations = []
  for (const file of [...(await markdownFiles(payloadDir)), ...extraFiles]) {
    const lines = (await readFile(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0
        const match = rule.pattern.exec(line)
        if (match) {
          violations.push(
            `${relative(ROOT, file)}:${index + 1}  ${rule.reason} — "${match[0]}"`
          )
        }
      }
    })
  }
  return violations
}

// Only run the CLI when this file is executed directly — importing it (e.g.
// from scripts/test-audit.mjs to unit-test RULES) must not also run the full
// payload audit and process.exit as a side effect of the import.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const violations = await auditPayload(PAYLOAD, EXTRA_SHIPPED_FILES)
  if (violations.length > 0) {
    console.error('Content rule violations:\n')
    for (const violation of violations) console.error(`  ${violation}`)
    console.error(`\n${violations.length} violation(s). See the plan's Global Constraints.`)
    process.exit(1)
  }
  console.log('content audit clean')
}

export { RULES, markdownFiles, auditPayload }
