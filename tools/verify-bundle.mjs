#!/usr/bin/env node
/**
 * verify-bundle.mjs — offline proof that this self-contained bundle is intact and
 * still matches the Open Design install it vendors from.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bundle ships OD's `.od-frames/` payload inside itself (`assets/frames/`) and
 * carries ~470 KB of vendored prompt prose in `cordis.patch.yml`. Both are copies of
 * another application's material, so both can go stale without anything failing:
 * Open Design updates, this bundle keeps shipping last month's frames, and the only
 * symptom is a designer that quietly gets wrong layout primitives. A copy that is not
 * checked is a copy that drifts.
 *
 * WHAT IT CHECKS
 * --------------
 * 1. every managed payload file exists, is non-empty, and matches the sha256 recorded
 *    in `assets/frames/SOURCES.json` (catches a half-copied or hand-edited asset);
 * 2. the four static shells are byte-identical to the installed OD originals, and
 *    `deck-framework.md` re-renders to the same bytes from OD's own daemon chunk —
 *    i.e. the vendored copy is what OD itself would write;
 * 3. each of the six preset rows names `od-frames` through this bundle's own package
 *    subpath, and that specifier resolves from the profile's module base;
 * 4. every other byte of the preset rows still matches the preset package's patch —
 *    proving the generator copied rather than rewrote;
 * 5. the payload reader in `od-frames.mjs` points at the in-package directory, not at
 *    a path outside the bundle.
 *
 * Checks 2 and 4 need files outside this package (the OD install, the sibling preset
 * package). When one is absent they WARN and continue: this script must be runnable
 * from a bare checkout, where its job is to prove the bundle is internally consistent.
 *
 * Exit 0 = pass, 1 = FAIL. Warnings do not fail the run.
 *
 * usage: node tools/verify-bundle.mjs [--strict]
 *        --strict turns "could not cross-check" warnings into failures, for a release
 *        gate that must not ship an unverified copy.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const FRAMES = path.join(PKG, 'assets', 'frames')
const SOURCES = path.join(FRAMES, 'SOURCES.json')
const PATCH = path.join(PKG, 'cordis.patch.yml')
const MODULE = path.join(PKG, 'od-frames.mjs')
const OD_FRAMES_SPECIFIER = '@local/dsh-opendesign-plugin/od-frames'
const PRESET_PATCH = 'C:/Users/Administrator/.dsh/presets/opendesign/cordis.patch.yml'
const PROFILE_MODULES = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/'
const OD_ROOT = 'C:/Users/Administrator/AppData/Local/Programs/Open Design/resources'
const OD_PROTOTYPE = path.join(
  OD_ROOT,
  'open-design/plugins/_official/scenarios/od-next-strategy/assets/task-profiles/prototype',
)
const OD_DAEMON_CHUNK = path.join(OD_ROOT, 'app/prebundled/daemon/chunks/chunk-NJ5UFL7I.mjs')

const strict = process.argv.includes('--strict')
const fails = []
const warns = []
const ok = (m) => console.log(`ok   ${m}`)
const warn = (m) => {
  warns.push(m)
  console.log(`warn ${m}`)
}
const fail = (m) => {
  fails.push(m)
  console.log(`FAIL ${m}`)
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/* ------------------------------------------------ 1. payload vs SOURCES.json */

const MANAGED = ['iphone.html', 'android.html', 'neutral.html', 'layout.css', 'deck-framework.md']

if (!fs.existsSync(SOURCES)) {
  fail(`missing ${SOURCES}; without it the payload has no recorded provenance`)
} else {
  const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'))
  const recorded = sources.files ?? {}
  const missing = MANAGED.filter((f) => !fs.existsSync(path.join(FRAMES, f)))
  if (missing.length > 0) fail(`payload files missing: ${missing.join(', ')}`)

  for (const file of MANAGED) {
    const rec = recorded[file]
    if (rec === undefined) {
      fail(`${file} is shipped but not recorded in SOURCES.json`)
      continue
    }
    const abs = path.join(FRAMES, file)
    if (!fs.existsSync(abs)) continue
    const buf = fs.readFileSync(abs)
    if (buf.length === 0) {
      fail(`${file} is empty`)
      continue
    }
    const expectedBytes = rec.storedBytes ?? rec.sourceBytes
    if (buf.length !== expectedBytes) {
      fail(`${file} size drifted: ${buf.length} != recorded ${expectedBytes}`)
      continue
    }
    // Static records carry only `sourceSha256` (the copy is verbatim, so stored and
    // source are the same digest); rendered records carry `storedSha256`. Accepting
    // either keeps one invariant per record instead of two fields that must agree.
    const expectedSha = rec.storedSha256 ?? rec.sourceSha256
    if (typeof expectedSha !== 'string') {
      fail(`${file} has no recorded digest in SOURCES.json`)
      continue
    }
    const actual = sha256(buf)
    if (actual !== expectedSha) {
      fail(`${file} content drifted: ${actual.slice(0, 16)}… != recorded ${expectedSha.slice(0, 16)}…`)
      continue
    }
    // A static record is a byte copy, so stored and source digests must agree. A
    // `generated` record (deck-framework.md) is *rendered* from the daemon chunk, so it
    // has no source digest at all; its fidelity is proven by the re-render check instead.
    // Conflating the two made this check assert something the manifest never claimed.
    if (rec.kind === 'static' && rec.storedSha256 !== undefined && rec.storedSha256 !== rec.sourceSha256) {
      fail(`${file} is a static copy but its stored and source digests differ`)
      continue
    }
    if (rec.kind === 'static' && rec.storedSha256 === undefined && rec.sourceSha256 === undefined) {
      fail(`${file} is a static copy with no recorded digest`)
      continue
    }
    ok(`${file} matches its recorded sha256 (${buf.length} B)`)
  }

  // SOURCES.json must describe the same file set the manifest claims, so a file
  // cannot be added or dropped without the record following it.
  const extra = Object.keys(recorded).filter((f) => !MANAGED.includes(f))
  if (extra.length > 0) warn(`SOURCES.json records unmanaged entries: ${extra.join(', ')}`)
}

/* ------------------------------------------- 2. fidelity against the OD install */

const STATIC = {
  'iphone.html': path.join(OD_PROTOTYPE, 'device-frames', 'iphone.html'),
  'android.html': path.join(OD_PROTOTYPE, 'device-frames', 'android.html'),
  'neutral.html': path.join(OD_PROTOTYPE, 'device-frames', 'neutral.html'),
  'layout.css': path.join(OD_PROTOTYPE, 'layout.css'),
}

if (!fs.existsSync(OD_PROTOTYPE)) {
  const m = `OD install not found at ${OD_PROTOTYPE}; source fidelity unverified (recorded sha256 still enforced)`
  if (strict) fail(m)
  else warn(m)
} else {
  const drifted = []
  for (const [file, src] of Object.entries(STATIC)) {
    if (!fs.existsSync(src)) {
      warn(`OD original missing, cannot cross-check ${file}`)
      continue
    }
    if (sha256(fs.readFileSync(src)) !== sha256(fs.readFileSync(path.join(FRAMES, file)))) {
      drifted.push(file)
    }
  }
  if (drifted.length > 0) {
    // The important case: OD updated, the copy did not. Name the fix, not just the fault.
    fail(
      `vendored frames drifted from the installed OD originals: ${drifted.join(', ')}. ` +
        'Re-run the preset package\'s tools/stage-frames.mjs, then copy assets/frames/ here ' +
        'and refresh SOURCES.json.',
    )
  } else {
    ok('4 static frame assets are byte-identical to the installed OD originals')
  }
}

/* -------------------------------------- 3. deck-framework.md re-renders exactly */

if (!fs.existsSync(OD_DAEMON_CHUNK)) {
  const m = `OD daemon chunk not found (${OD_DAEMON_CHUNK}); deck-framework origin unverified`
  if (strict) fail(m)
  else warn(m)
} else {
  try {
    const mod = await import(pathToFileURL(OD_DAEMON_CHUNK).href)
    const rendered = [
      '# HTML deck host protocol',
      'Apply only to PPT outputs. If editing existing deck/template HTML, follow the compatibility section and preserve its scaffold. For a new deck use the canonical section. Do not create a deck solely because this file exists.',
      '## Existing deck or selected template',
      mod.renderLegacyDeckCompatibilityDirective('filesystem'),
      '## New deck only',
      mod.renderDeckFrameworkDirective('filesystem'),
    ].join('\n\n')
    const stored = fs.readFileSync(path.join(FRAMES, 'deck-framework.md'), 'utf8')
    if (rendered !== stored) {
      fail(
        'deck-framework.md does not match a fresh render from the OD daemon chunk. ' +
          'Re-render from the installed chunk and update SOURCES.json.',
      )
    } else {
      ok(`deck-framework.md re-renders byte-identically (${Buffer.byteLength(stored)} B)`)
    }
  } catch (e) {
    fail(`could not re-render deck-framework.md: ${e.message}`)
  }
}

/* ------------------------------------------- 4. row specifiers and the package */

const patchText = fs.readFileSync(PATCH, 'utf8')
const rowNames = [...patchText.matchAll(/^\s*name:\s*'([^']*od-frames[^']*)'\s*$/gm)].map((m) => m[1])
if (rowNames.length !== 6) {
  fail(`expected 6 od-frames row names, found ${rowNames.length}`)
} else if (rowNames.some((n) => n !== OD_FRAMES_SPECIFIER)) {
  fail(
    `od-frames rows must all name ${OD_FRAMES_SPECIFIER}; got ${JSON.stringify([...new Set(rowNames)])}. ` +
      'A file: URL here pins the bundle to one machine and user.',
  )
} else {
  ok(`all 6 od-frames rows name ${OD_FRAMES_SPECIFIER}`)
}

// The specifier must actually resolve the way the Loader resolves it: a bare package
// name goes to Node's resolver against the profile's module base, not beside the patch.
{
  let resolved
  try {
    const require = (await import('node:module')).createRequire(PROFILE_MODULES)
    resolved = require.resolve(OD_FRAMES_SPECIFIER)
  } catch (e) {
    fail(`package specifier does not resolve from the profile module base: ${e.message}`)
  }
  if (resolved !== undefined) {
    if (path.resolve(resolved) !== path.resolve(MODULE)) {
      fail(`specifier resolves outside this package: ${resolved}`)
    } else {
      const mod = await import(`${pathToFileURL(resolved).href}?verify=${Date.now()}`)
      if (mod.name !== 'od-frames' || typeof mod.apply !== 'function') {
        fail(`resolved module lacks the Cordis contract (name/apply): ${resolved}`)
      } else {
        ok('resolves to this package\'s od-frames module and loads the Cordis contract')
      }
    }
  }
}

// Absolute paths anywhere in the patch mean the bundle is machine-bound again.
const absolute = [...patchText.matchAll(/file:\/\/\/[^\s']*/g)].map((m) => m[0])
if (absolute.length > 0) {
  fail(`patch contains ${absolute.length} absolute file: URL(s), e.g. ${absolute[0]}`)
} else {
  ok('patch contains no absolute file: URLs')
}

/* ------------------------------- 5. every other row byte equals the source rows */

if (!fs.existsSync(PRESET_PATCH)) {
  const m = `preset source patch not found (${PRESET_PATCH}); verbatim fidelity unverified`
  if (strict) fail(m)
  else warn(m)
} else {
  // Compare the preset rows with the source's, after applying the same one rewrite the
  // generator performs. A difference means the copy stopped being a copy.
  const sourceRows = fs
    .readFileSync(PRESET_PATCH, 'utf8')
    .split('\n')
    .map((l) => (/^(\s*name:\s*)'file:[^']*od-frames\.mjs'\s*$/.exec(l) === null
      ? l
      : `${/^(\s*name:\s*)'file:[^']*od-frames\.mjs'\s*$/.exec(l)[1]}'${OD_FRAMES_SPECIFIER}'`))
  const strip = (lines) => {
    const out = [...lines]
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out.join('\n')
  }
  // The bundle's rows are the six preset blocks under its single `insert:`; reconstruct
  // them the same way the generator does so this compares like with like. The bundle's
  // own Host row (and its comment) sits above the first preset row and is this package's
  // original work, not carried content — start counting at the first `- id: preset-`.
  const carried = []
  let inBlock = false
  let sawPreset = false
  for (const line of patchText.split('\n')) {
    if (/^- insert:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (/^ {4}- id: preset-/.test(line)) {
      sawPreset = true
      carried.push(line)
      continue
    }
    if (/^\S/.test(line)) {
      inBlock = false
      continue
    }
    if (sawPreset) carried.push(line)
  }
  const sourceCarried = []
  inBlock = false
  for (const line of sourceRows) {
    if (/^- insert:\s*$/.test(line)) {
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (/^ {4}- id: preset-/.test(line)) {
      sourceCarried.push(line)
      continue
    }
    if (/^\S/.test(line)) {
      inBlock = false
      continue
    }
    sourceCarried.push(line)
  }
  const a = sha256(strip(carried))
  const b = sha256(strip(sourceCarried))
  if (a !== b) {
    fail(
      'preset rows are no longer byte-identical to the preset package\'s patch. ' +
        'Regenerate with tools/build-plugin-patch.mjs rather than editing the patch by hand.',
    )
  } else {
    ok(`preset rows match the source patch verbatim (${carried.length} lines, sha256 ${a.slice(0, 12)}…)`)
  }
}

/* --------------------------------- 6. the module reads the in-package payload */

{
  const text = fs.readFileSync(MODULE, 'utf8')
  const assets = /^const ASSETS = path\.resolve\(HERE, (.*)\)$/m.exec(text)
  if (assets === null) {
    warn('could not locate the ASSETS constant in od-frames.mjs; payload location unverified')
  } else if (!assets[1].includes("'assets'")) {
    fail(`od-frames.mjs reads its payload from outside the bundle: path.resolve(HERE, ${assets[1]})`)
  } else if (assets[1].includes('..')) {
    fail(`od-frames.mjs payload path escapes the package: path.resolve(HERE, ${assets[1]})`)
  } else {
    ok(`od-frames.mjs reads payload from the bundle (path.resolve(HERE, ${assets[1]}))`)
  }
}

/* --------------------------------------------------------------- summary */

/* ---------------------------------- 7. DSH host contracts this bundle uses */

/**
 * The bundle is written against specific DSH behavior, and the expensive failures are
 * the silent ones: a changed Loader resolution turns every preset into a load-failed
 * badge, and a changed `tools.register` contract fails every tool call in the session
 * at request time. `host-contracts.json` names each contract; the checks here are the
 * statically decidable subset. The rest are exercised at runtime and say so in their
 * `how` field — this script must not pretend to prove what only a live call can.
 */
{
  const contractsPath = path.join(PKG, 'host-contracts.json')
  if (!fs.existsSync(contractsPath)) {
    fail(`missing ${contractsPath}; the bundle's DSH contracts are undocumented, so an upgrade cannot be diffed`)
  } else {
    const doc = JSON.parse(fs.readFileSync(contractsPath, 'utf8'))
    const ids = new Set((doc.contracts ?? []).map((c) => c.id))
    for (const required of ['inject-array', 'tool-schema-json', 'row-name-resolution', 'sendMessage-cold-resume']) {
      if (!ids.has(required)) fail(`host-contracts.json no longer documents "${required}"`)
    }

    const indexText = fs.readFileSync(path.join(PKG, 'index.js'), 'utf8')

    // inject-array: an array literal, never the { required, optional } object shape.
    if (!/^export const inject = \[[^\]]*\]$/m.test(indexText)) {
      fail('index.js `inject` is not a plain array literal (Cordis reads any other shape as service names)')
    } else {
      ok('inject is an array literal')
    }

    // tool-schema-json: object-level `required` arrays, no per-property `required: true`.
    // The cheap proof is that both registered tools build real JSON Schema; the expensive
    // proof (provider acceptance) only a live call gives.
    const toolBlocks = [...indexText.matchAll(/name: '(design_[a-z]+)',[\s\S]*?\n {4}\},\n {2}\}\)?/g)]
    if (toolBlocks.length < 2) {
      warn('could not isolate both tool definitions in index.js; per-property required not checked')
    } else {
      const bad = toolBlocks.filter((b) => /\n\s{8}(brief|mode|subagent_id|message):\s*\{[^}]*required:\s*true/.test(b[0]))
      if (bad.length > 0) {
        fail('a tool parameter carries per-property `required: true`; the provider will reject the whole request')
      } else {
        ok('no per-property `required: true` on tool parameters (real JSON Schema)')
      }
    }

    // row-name-resolution: the patch must address od-frames by package specifier only.
    if (/name:\s*'\.\.?\//.test(patchText)) {
      fail('patch contains a relative row name; preset rows resolve against the profile root and would fail to import')
    } else {
      ok('patch contains no relative row names')
    }

    // sendMessage-cold-resume: design_reply must go through the subagent service, not
    // through the Team roster (which is what made it unreachable in the first place).
    if (!/ctx\.subagents|requireService\(ctx, 'subagents'\)/.test(indexText)) {
      fail('index.js does not reach the `subagents` service; design_reply would fall back to the Team roster')
    } else {
      ok('index.js reaches the subagents service directly')
    }

    // The Team-owns-send_message fact is the reason this bundle has its own tool. If the
    // Team bundle is no longer in the profile, `design_reply` is unnecessary but harmless;
    // say so rather than failing.
    const profilePkg = 'C:/Users/Administrator/.dsh/profiles/desktop/package.json'
    if (!fs.existsSync(profilePkg)) {
      warn('profile package.json not found; cannot report whether the Team profile is active')
    } else {
      const bundles = JSON.parse(fs.readFileSync(profilePkg, 'utf8'))?.dsh?.profile?.bundles ?? []
      const teamActive = bundles.includes('@deepseek-ai/dsh-experimental-agent-team-profile')
      if (teamActive) {
        ok('Agent Teams profile is active, so design_reply is the only way to reach a design child')
      } else {
        warn('Agent Teams profile is not active; design_reply is redundant here (send_message would work)')
      }
    }
  }
}

console.log('')
if (warns.length > 0) console.log(`${warns.length} warning(s) — cross-checks that could not run`)
if (fails.length > 0) {
  console.log(`\n${fails.length} FAILURE(S):`)
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('PASS: bundle is self-contained and matches its vendors.')
