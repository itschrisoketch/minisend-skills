#!/usr/bin/env node
/**
 * Installs the Minisend skill into a project's agent skills directory.
 * Zero dependencies and no network access — the payload ships inside the
 * package.
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAYLOAD = resolve(HERE, '..', 'skills', 'minisend')
const SKILL_NAME = 'minisend'

const USAGE = `
Install the Minisend integration skill.

  npx @minisend/skill [options]

Options:
  --dir <path>      Install into <path>/${SKILL_NAME} instead of the defaults
  --force, -f       Overwrite an existing install, removing stale files first
  --help, -h        Show this message

By default the skill is installed to .claude/skills/${SKILL_NAME}, and also to
.agents/skills/${SKILL_NAME} when that directory already exists.
`

function parseArgs(argv) {
  const options = { dir: null, force: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--force' || arg === '-f') options.force = true
    else if (arg === '--dir') {
      const value = argv[++i]
      // Reject a following flag rather than swallowing it as the path —
      // otherwise `--dir --force` silently creates a directory named "--force"
      // and drops --force on the floor.
      if (!value || value.startsWith('-')) {
        console.error('--dir requires a path')
        process.exit(1)
      }
      options.dir = value
    } else {
      console.error(`Unknown option: ${arg}`)
      console.error(USAGE)
      process.exit(1)
    }
  }
  return options
}

function resolveTargets(options, cwd) {
  if (options.dir) return [resolve(cwd, options.dir, SKILL_NAME)]
  const targets = [resolve(cwd, '.claude', 'skills', SKILL_NAME)]
  if (existsSync(resolve(cwd, '.agents', 'skills'))) {
    targets.push(resolve(cwd, '.agents', 'skills', SKILL_NAME))
  }
  return targets
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const cwd = process.cwd()
const targets = resolveTargets(options, cwd)

if (!options.force) {
  const existing = targets.filter((target) => existsSync(target))
  if (existing.length > 0) {
    console.error('The Minisend skill is already installed at:')
    for (const target of existing) console.error(`  ${target}`)
    console.error('\nRe-run with --force to overwrite.')
    process.exit(1)
  }
}

for (const target of targets) {
  if (options.force && existsSync(target)) {
    // Remove first so --force produces a clean mirror of the payload rather
    // than merging over it — files dropped from a future payload must not
    // survive as stale leftovers.
    await rm(target, { recursive: true, force: true })
  }
  await mkdir(dirname(target), { recursive: true })
  await cp(PAYLOAD, target, { recursive: true })
  console.log(`Installed the Minisend skill to ${target}`)
}

console.log(
  '\nAsk your agent something like:\n' +
    '  "Using the minisend skill, add a KES payout to this app."'
)
