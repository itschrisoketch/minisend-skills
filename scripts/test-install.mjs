#!/usr/bin/env node
/**
 * Installer test harness. No test framework — the package ships with zero
 * dependencies, so the test is a script that throws.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = resolve(HERE, '..', 'bin', 'install.mjs')

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log(`  ok  ${label}`)
  } else {
    console.error(`FAIL  ${label}`)
    failures++
  }
}

function run(cwd, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [INSTALLER, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const sandbox = await mkdtemp(join(tmpdir(), 'minisend-skill-test-'))

try {
  // 1. Default install lands in .claude/skills/minisend
  const first = run(sandbox)
  check('default install exits 0', first.code === 0)
  check('SKILL.md installed', existsSync(join(sandbox, '.claude/skills/minisend/SKILL.md')))

  // 2. Re-running without --force refuses rather than clobbering
  await writeFile(join(sandbox, '.claude/skills/minisend/SKILL.md'), 'LOCAL EDIT')
  const second = run(sandbox)
  check('second install exits non-zero', second.code !== 0)
  const preserved = await readFile(join(sandbox, '.claude/skills/minisend/SKILL.md'), 'utf8')
  check('local edit preserved without --force', preserved === 'LOCAL EDIT')

  // 3. --force overwrites
  const forced = run(sandbox, ['--force'])
  check('--force exits 0', forced.code === 0)
  const overwritten = await readFile(join(sandbox, '.claude/skills/minisend/SKILL.md'), 'utf8')
  check('--force overwrote the local edit', overwritten !== 'LOCAL EDIT')

  // 3b. --force produces a clean mirror — stray files left by a previous
  // payload must not survive a forced reinstall.
  const strayFile = join(sandbox, '.claude/skills/minisend/stray.txt')
  await writeFile(strayFile, 'should not survive a --force reinstall')
  const forcedAgain = run(sandbox, ['--force'])
  check('second --force exits 0', forcedAgain.code === 0)
  check('--force removes stray files from a previous install', !existsSync(strayFile))

  // 4. --dir is honoured
  const custom = join(sandbox, 'custom-skills')
  const dirRun = run(sandbox, ['--dir', custom])
  check('--dir exits 0', dirRun.code === 0)
  check('--dir installed to the given path', existsSync(join(custom, 'minisend/SKILL.md')))

  // 4b. --dir must not swallow the next flag as its path. `--dir --force`
  // used to create a literal directory named "--force" and silently drop the
  // --force it consumed.
  const flagAsDir = run(sandbox, ['--dir', '--force'])
  check('--dir followed by a flag exits non-zero', flagAsDir.code !== 0)
  check('--dir followed by a flag reports the missing path', flagAsDir.stdout.includes('--dir requires a path'))
  check('--dir followed by a flag creates no "--force" directory', !existsSync(join(sandbox, '--force')))

  // 4c. A trailing --dir with nothing after it is still rejected.
  const bareDir = run(sandbox, ['--dir'])
  check('trailing --dir exits non-zero', bareDir.code !== 0)

  // 5. .agents/skills is picked up when present
  const agentsSandbox = await mkdtemp(join(tmpdir(), 'minisend-skill-agents-'))
  await mkdir(join(agentsSandbox, '.agents/skills'), { recursive: true })
  const agentsRun = run(agentsSandbox)
  check('install with .agents/skills exits 0', agentsRun.code === 0)
  check('installed to .agents/skills too', existsSync(join(agentsSandbox, '.agents/skills/minisend/SKILL.md')))
  await rm(agentsSandbox, { recursive: true, force: true })

  // 6. Partial conflict: one of the two default targets already exists and the
  // other does not. The refusal must be all-or-nothing — a half install that
  // writes .agents/skills while refusing .claude/skills would leave the two
  // copies permanently out of sync.
  const partialSandbox = await mkdtemp(join(tmpdir(), 'minisend-skill-partial-'))
  await mkdir(join(partialSandbox, '.agents/skills'), { recursive: true })
  await mkdir(join(partialSandbox, '.claude/skills/minisend'), { recursive: true })
  await writeFile(join(partialSandbox, '.claude/skills/minisend/SKILL.md'), 'LOCAL EDIT')
  const partial = run(partialSandbox)
  check('partial conflict exits non-zero', partial.code !== 0)
  check(
    'partial conflict preserves the existing target',
    (await readFile(join(partialSandbox, '.claude/skills/minisend/SKILL.md'), 'utf8')) === 'LOCAL EDIT'
  )
  check(
    'partial conflict does not install the non-conflicting target',
    !existsSync(join(partialSandbox, '.agents/skills/minisend'))
  )
  // --force then completes both.
  const partialForced = run(partialSandbox, ['--force'])
  check('--force resolves the partial conflict', partialForced.code === 0)
  check(
    '--force installed the previously conflicting target',
    (await readFile(join(partialSandbox, '.claude/skills/minisend/SKILL.md'), 'utf8')) !== 'LOCAL EDIT'
  )
  check(
    '--force installed the previously missing target',
    existsSync(join(partialSandbox, '.agents/skills/minisend/SKILL.md'))
  )
  await rm(partialSandbox, { recursive: true, force: true })
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall installer checks passed')
