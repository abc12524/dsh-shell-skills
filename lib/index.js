/**
 * dsh-shell-skills — Host half.
 *
 * Runs shell-tool style Python skills: one folder per skill
 * (`<root>/<name>/skill.py`), a leading `# skill: <name>` comment header, and a
 * `run(arguments)` entry function. This plugin does not execute anything in its
 * own process; every run is a `python lib/runner.py` child process, so a broken
 * skill cannot take the harness down.
 *
 * Two faces are published:
 *
 * - the `shellSkills` Cordis service — the stable read interface for
 *   `dsh-inject-context` (`list()` returns installed and enabled skills only);
 * - the `shell_skill` tool — list / usage / run / install / remove for the model.
 *
 * The manager card on the Plugins page cannot call a custom Remote namespace:
 * `@deepseek-ai/dsh-api-remotes` selects its client contributions at build time.
 * So the card and the Host talk through volatile settings fields — the card
 * writes `pendingAction`, the Host polls it once per second, performs the
 * action, and writes the resulting lists back. Both sides are inside this
 * plugin, so the protocol stays private and needs no wire changes.
 *
 * @module dsh-shell-skills
 */

import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'


import z from '@deepseek-ai/schemastery'

/** Stable plugin id, matching the loader entry id in cordis.patch.yml. */
export const name = 'dsh-shell-skills'

/**
 * Required services. Intentionally empty: the tool registry and the settings
 * service are looked up opportunistically. A hard `inject: ['tools']` would
 * keep the whole plugin pending — and therefore hide the settings card — on a
 * deployment where the registry is not visible from this context; the manager
 * and the `shellSkills` service do not need it.
 */
export const inject = []

/** Profile entry id of the editable settings form. */
const NS = 'dsh-shell-skills'

/** Profile entry id and service name of the volatile state surface. */
const STATE_NS = 'dsh-shell-skills-state'
const STATE_SERVICE = 'shellSkillsState'

/** Cordis service name read by `dsh-inject-context`. */
const SERVICE = 'shellSkills'

/** Remote hub defaults, matching shell-tool. */
const DEFAULT_REPO = 'abc12524/shell-skills'
const DEFAULT_BRANCH = 'main'

/** Entry file name inside each skill folder. */
const SKILL_FILE = 'skill.py'

/** Header parsing bounds, matching shell-tool's scanner. */
const HEADER_LINE_LIMIT = 300

/** Python runner shipped beside this file. */
const RUNNER = fileURLToPath(new URL('./runner.py', import.meta.url))

/** Characters allowed in a skill name (also used as a directory name). */
const NAME_RE = /^[A-Za-z0-9_.\-]+$/

/** Skill statuses understood by the header. */

const DISABLED_VALUES = new Set(['disable', 'disabled', 'off', 'false', '0'])

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The plugin's editable configuration.
 *
 * Only user-facing settings live here. The manager's volatile state
 * (`installedJson`, `remoteJson`, `statusJson`, `pendingAction`,
 * `lastActionId`) lives in the sibling `dsh-shell-skills-state` entry, so a
 * state write never invalidates the revision this form was opened at.
 *
 * Operational knobs (`root`, `pythonPath`, timeouts) stay ordinary
 * configuration in the profile patch.
 */
export const Config = z.object({
  /** Master switch for periodic scanning. */
  'enabled': z.boolean().default(true).volatile(),
  /** Remote hub kind: `github` or `gitea`. */
  'hubType': z.string().default('github').volatile(),
  /** Gitea base URL (ignored for github). */
  'hubBase': z.string().default('').volatile(),
  /** Remote repository as `owner/repo`. */
  'hubRepo': z.string().default(DEFAULT_REPO).volatile(),
  /** Remote branch. */
  'hubBranch': z.string().default(DEFAULT_BRANCH).volatile(),

  // Ordinary configuration — profile patch only.
  /** Skill root; empty means `~/.dsh/shell-skills`. `~` is expanded. */
  'root': z.string().default(''),
  /** Python interpreter; empty means `python` on Windows and `python3` elsewhere. */
  'pythonPath': z.string().default(''),
  /** Per-run timeout in milliseconds. */
  'runTimeoutMs': z.number().step(1).min(1000).default(60000),
  /** Per-request timeout for hub downloads. */
  'installTimeoutMs': z.number().step(1).min(1000).default(30000),
  /** Credential reference holding a hub token (`GITHUB_TOKEN` / `GITEA_TOKEN`). */
  'hubTokenRef': z.string().role('credential-ref').default('SHELL_SKILLS_TOKEN'),
})

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Read one config field, unwrapping a live `{ get() }` reference.
 * @param config - the resolved plugin configuration.
 * @param key - field name.
 * @param fallback - value when the field is missing or unreadable.
 * @returns the current value.
 */
function readConfig(config, key, fallback) {
  const field = config?.[key]
  let value = field
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    try {
      value = field.get()
    } catch {
      return fallback
    }
  }
  return value === undefined || value === null ? fallback : value
}

/**
 * Resolve the skill root, expanding a leading `~`.
 * @param config - the resolved plugin configuration.
 * @returns an absolute directory path.
 */
function resolveRoot(config) {
  const configured = String(readConfig(config, 'root', '') ?? '').trim()
  if (configured.length === 0) return join(homedir(), '.dsh', 'shell-skills')
  return resolve(configured.replace(/^~(?=$|[\\/])/, homedir()))
}

/**
 * Whether a header status means "enabled".
 *
 * Matches shell-tool: anything that is not an explicit disable value is
 * enabled, including a missing or unrecognized status.
 */
function isEnabled(meta) {
  const value = String(meta?.status ?? 'enable').trim().toLowerCase()
  return !DISABLED_VALUES.has(value)
}

// ---------------------------------------------------------------------------
// Header parsing (a faithful port of core/tools/skill_tool.py)
// ---------------------------------------------------------------------------

const SKILL_RE = /^#\s*skill\s*:\s*(\S+)\s*$/i
const DESC_RE = /^#\s*description\s*:\s*(.*)$/i
const STATUS_RE = /^#\s*status\s*:\s*(\S+)\s*$/i
const USAGE_RE = /^#\s*usage\s*:\s*(.*)$/i
const HASH_PREFIX_RE = /^#\s?/

/**
 * Parse one entry file's header without importing it.
 * @param text - the entry file's text.
 * @returns metadata, or `undefined` when no `# skill:` name is declared.
 */
function parseSkillHeader(text) {
  const lines = text.split(/\r?\n/).slice(0, HEADER_LINE_LIMIT)
  let skillName
  let description = ''
  let status = 'enable'
  let inUsage = false
  const usage = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) {
      if (skillName !== undefined && inUsage) usage.push('')
      continue
    }
    if (!line.startsWith('#')) break
    const skillMatch = SKILL_RE.exec(line)
    if (skillMatch) {
      skillName = skillMatch[1]
      continue
    }
    if (skillName === undefined) continue
    const descMatch = DESC_RE.exec(line)
    if (descMatch && !inUsage) {
      description = descMatch[1].trim()
      continue
    }
    const statusMatch = STATUS_RE.exec(line)
    if (statusMatch && !inUsage) {
      status = statusMatch[1].trim().toLowerCase()
      continue
    }
    const usageMatch = USAGE_RE.exec(line)
    if (usageMatch) {
      inUsage = true
      const rest = usageMatch[1].trim()
      if (rest.length > 0) usage.push(rest)
      continue
    }
    if (inUsage) usage.push(HASH_PREFIX_RE.test(line) ? line.replace(HASH_PREFIX_RE, '') : line)
  }
  if (skillName === undefined) return undefined
  return { name: skillName, description, status, usage: usage.join('\n').trim() }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Scan the skill root.
 *
 * Only `<root>/<name>/skill.py` folders participate; names starting with `_`
 * or `.` are helper/scratch folders, exactly as shell-tool treats them. Files
 * are re-read only when their `(mtime, size)` changed.
 *
 * @param root - absolute skill root.
 * @param cache - path → `{ mtimeMs, size, meta }` memo.
 * @param signal - optional cancellation.
 * @returns installed skill descriptors in directory order.
 */
async function scanSkills(root, cache, signal) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted?.()
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const path = join(root, entry.name, SKILL_FILE)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    const cached = cache.get(path)
    let meta
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      meta = cached.meta
    } else {
      let text
      try {
        text = await readFile(path, 'utf8')
      } catch {
        continue
      }
      meta = parseSkillHeader(text)
      cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, meta })
    }
    if (!meta) continue
    skills.push({ ...meta, dir: join(root, entry.name), path })
  }
  return skills
}

// ---------------------------------------------------------------------------
// Status rewriting (preserves BOM and line endings)
// ---------------------------------------------------------------------------

/**
 * Rewrite the `# status:` header line, inserting it after `# description:` when
 * absent. The rest of the file is untouched.
 * @param text - file text with `\n` line endings.
 * @param value - `enable` or `disable`.
 * @returns the rewritten text.
 */
function rewriteStatus(text, value) {
  const lines = text.split('\n')
  let end = 0
  while (end < lines.length) {
    const stripped = lines[end].trim()
    if (stripped.length > 0 && !stripped.startsWith('#')) break
    end += 1
  }
  const statusRe = /^#\s*status\s*:/i
  let insertAt
  for (let i = 0; i < end; i += 1) {
    if (statusRe.test(lines[i].trim())) {
      lines[i] = `# status: ${value}`
      return lines.join('\n')
    }
    if (insertAt === undefined && DESC_RE.test(lines[i].trim())) insertAt = i + 1
  }
  if (insertAt === undefined) {
    for (let i = 0; i < end; i += 1) {
      if (SKILL_RE.test(lines[i].trim())) {
        insertAt = i + 1
        break
      }
    }
  }
  if (insertAt === undefined) insertAt = end
  lines.splice(insertAt, 0, `# status: ${value}`)
  return lines.join('\n')
}

/**
 * Set a skill's status by rewriting its header in place.
 * @param root - absolute skill root.
 * @param skillName - skill name from the header.
 * @param status - `enable` or `disable`.
 * @param cache - the scan memo.
 * @returns the updated descriptor.
 */
async function setSkillStatus(root, skillName, status, cache) {
  const value = String(status ?? '').trim().toLowerCase()
  if (value !== 'enable' && value !== 'disable') {
    throw new Error(`status must be enable or disable, got "${String(status)}"`)
  }
  const skills = await scanSkills(root, cache)
  const target = skills.find((skill) => skill.name === skillName)
  if (!target) throw new Error(`unknown skill "${skillName}"`)

  const raw = await readFile(target.path)
  const hasBom = raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF
  const newline = raw.includes('\r\n') ? '\r\n' : '\n'
  let text = raw.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  text = rewriteStatus(text, value)
  if (newline === '\r\n') text = text.replace(/\n/g, '\r\n')
  await writeFile(target.path, Buffer.from(`${hasBom ? '\uFEFF' : ''}${text}`, 'utf8'))
  cache.delete(target.path)
  return { ...target, status: value }
}

// ---------------------------------------------------------------------------
// Remote hub (GitHub / Gitea Contents API)
// ---------------------------------------------------------------------------

/** @typedef {{ kind: 'github' | 'gitea', base: string, repo: string, branch: string }} Hub */

/**
 * Read the hub settings from config.
 * @param config - the resolved plugin configuration.
 * @returns the normalized hub.
 */
function hubOf(config) {
  const kind = String(readConfig(config, 'hubType', 'github')).trim().toLowerCase() === 'gitea' ? 'gitea' : 'github'
  return {
    kind,
    base: String(readConfig(config, 'hubBase', '') ?? '').trim().replace(/\/+$/, ''),
    repo: String(readConfig(config, 'hubRepo', DEFAULT_REPO) ?? '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_REPO,
    branch: String(readConfig(config, 'hubBranch', DEFAULT_BRANCH) ?? '').trim() || DEFAULT_BRANCH,
  }
}

/**
 * The raw `index.json` URL for a hub.
 * @param hub - hub settings.
 * @returns the URL.
 */
function indexUrl(hub) {
  if (hub.kind === 'gitea') {
    if (hub.base.length === 0) throw new Error('gitea hub requires hubBase')
    return `${hub.base}/${hub.repo}/raw/branch/${hub.branch}/index.json`
  }
  return `https://raw.githubusercontent.com/${hub.repo}/${hub.branch}/index.json`
}

/**
 * The Contents API URL for a repository path.
 * @param hub - hub settings.
 * @param repoPath - path inside the repository.
 * @returns the URL.
 */
function contentsUrl(hub, repoPath) {
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/')
  if (hub.kind === 'gitea') {
    if (hub.base.length === 0) throw new Error('gitea hub requires hubBase')
    return `${hub.base}/api/v1/repos/${hub.repo}/contents/${encoded}?ref=${encodeURIComponent(hub.branch)}`
  }
  return `https://api.github.com/repos/${hub.repo}/contents/${encoded}?ref=${encodeURIComponent(hub.branch)}`
}

/**
 * Headers for hub requests.
 * @param hub - hub settings.
 * @param token - optional token literal.
 * @returns request headers.
 */
function hubHeaders(hub, token) {
  const headers = {
    'User-Agent': 'dsh-shell-skills',
    Accept: hub.kind === 'gitea' ? 'application/json' : 'application/vnd.github+json',
  }
  if (token) headers.Authorization = hub.kind === 'gitea' ? `token ${token}` : `Bearer ${token}`
  return headers
}

/**
 * Resolve the hub token from the credentials domain, when available.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @returns the token literal, or undefined.
 */
async function hubToken(ctx, config) {
  const ref = String(readConfig(config, 'hubTokenRef', 'SHELL_SKILLS_TOKEN') ?? '').trim()
  if (ref.length === 0) return undefined
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
  try {
    const resolved = await credentials.resolve(ref)
    const value = resolved?.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Fetch the remote index.
 * @param hub - hub settings.
 * @param args - token and cancellation.
 * @returns the `skills` array.
 */
async function fetchRemoteIndex(hub, { token, signal, timeoutMs }) {
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000
  const response = await fetch(indexUrl(hub), {
    headers: hubHeaders(hub, token),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout),
  })
  if (!response.ok) throw new Error(`index HTTP ${response.status} for ${indexUrl(hub)}`)
  const data = await response.json()
  const skills = Array.isArray(data) ? data : data?.skills
  if (!Array.isArray(skills)) throw new Error('index.json has no skills list')
  return skills
}

/**
 * Validate a repository-relative path: no absolute root, no `..` segment.
 * @param value - candidate path.
 * @returns the normalized path, or undefined when unsafe.
 */
function safeRelPath(value) {
  const rel = String(value ?? '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '')
  if (rel.length === 0 || rel.startsWith('/')) return undefined
  if (rel.split('/').some((part) => part === '..' || part === '')) return undefined
  return rel
}

/**
 * Reject names that cannot be used as a directory inside the root.
 * @param value - candidate skill name.
 * @returns the trimmed name.
 */
function safeSkillName(value) {
  const nameValue = String(value ?? '').trim()
  if (!NAME_RE.test(nameValue) || nameValue === '.' || nameValue === '..') {
    throw new Error(`invalid skill name "${nameValue}"`)
  }
  return nameValue
}

/**
 * Recursively download one repository subtree through the Contents API.
 *
 * The API is used instead of a tarball so no archive parser is needed. A
 * directory answers with an array; a file answers with an object carrying a
 * `download_url` (GitHub) or inline base64 `content` (Gitea).
 *
 * @param hub - hub settings.
 * @param repoPath - subtree path in the repository.
 * @param dest - local destination directory.
 * @param args - token, timeout, cancellation, and local config files to keep.
 * @returns the relative file paths written.
 */
async function downloadTree(hub, repoPath, dest, { token, timeoutMs, signal }) {
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000
  const response = await fetch(contentsUrl(hub, repoPath), {
    headers: hubHeaders(hub, token),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout),
  })
  if (!response.ok) throw new Error(`contents HTTP ${response.status} for ${repoPath}`)
  const data = await response.json()
  const entries = Array.isArray(data) ? data : [data]
  const written = []
  for (const entry of entries) {
    const entryName = String(entry?.name ?? '')
    if (entryName.length === 0 || entryName === '.' || entryName === '..') continue
    if (entryName.includes('/') || entryName.includes('\\')) continue
    if (entry?.type === 'dir') {
      const child = join(dest, entryName)
      await mkdir(child, { recursive: true })
      const rel = repoPath.length === 0 ? entryName : `${repoPath}/${entryName}`
      written.push(...await downloadTree(hub, rel, child, { token, timeoutMs: requestTimeout, signal }))
      continue
    }
    if (entry?.type !== 'file') continue
    const localPath = join(dest, entryName)
    const relLocal = relative(dest, localPath).split(sep).join('/')
    let body
    if (typeof entry.download_url === 'string' && entry.download_url.length > 0) {
      const fileResponse = await fetch(entry.download_url, {
        headers: hubHeaders(hub, token),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout),
      })
      if (!fileResponse.ok) throw new Error(`download HTTP ${fileResponse.status} for ${entryName}`)
      body = Buffer.from(await fileResponse.arrayBuffer())
    } else if (typeof entry.content === 'string' && entry.content.length > 0) {
      body = Buffer.from(entry.content.replace(/\s+/g, ''), 'base64')
    } else {
      continue
    }
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, body)
    written.push(relLocal)
  }
  return written
}

/**
 * Install one skill from the hub into `<root>/<name>`.
 *
 * The download lands in a temporary sibling and replaces the target atomically;
 * an existing `config.json` / `*.conf` is preserved, and `config.example.json`
 * is copied to `config.json` when no real config exists (shell-tool behavior).
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param skillName - remote skill name.
 * @returns `{ name, path, files }`.
 */
async function installSkill(ctx, config, skillName) {
  const nameValue = safeSkillName(skillName)
  const hub = hubOf(config)
  const timeoutMs = Number(readConfig(config, 'installTimeoutMs', 30000))
  const token = await hubToken(ctx, config)
  const index = await fetchRemoteIndex(hub, { token, timeoutMs })
  const entry = index.find((item) => String(item?.name ?? '').trim() === nameValue)
  if (!entry) throw new Error(`remote repository has no skill "${nameValue}"`)

  const repoPath = safeRelPath(entry.path ?? nameValue)
  if (!repoPath) throw new Error(`skill "${nameValue}" has an unsafe path`)

  const root = resolveRoot(config)
  const dest = join(root, nameValue)
  const tmp = `${dest}.tmp`
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })

  const written = await downloadTree(hub, repoPath, tmp, { token, timeoutMs })
  if (written.length === 0) {
    await rm(tmp, { recursive: true, force: true })
    throw new Error(`no files found under "${repoPath}"`)
  }

  // Local secrets and machine-specific config survive a reinstall.
  if (await exists(dest)) await copyPreserved(dest, tmp)
  await rm(dest, { recursive: true, force: true })
  await rename(tmp, dest)

  await copyExampleConfig(dest)
  return { name: nameValue, path: dest, files: written.length }
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** List local config files (`config.json`, `*.conf`) relative to a skill directory. */
async function listPreserved(dir) {
  const out = []
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.name === 'config.json' || entry.name.endsWith('.conf')) {
        out.push(relative(dir, full).split(sep).join('/'))
      }
    }
  }
  await walk(dir)
  return out
}

/** Copy preserved config files from the old install into the staged directory. */
async function copyPreserved(from, to) {
  for (const rel of await listPreserved(from)) {
    const source = join(from, ...rel.split('/'))
    const target = join(to, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
}


/** Copy `config.example.json` to `config.json` when the latter is missing. */
async function copyExampleConfig(dir) {
  const example = join(dir, 'config.example.json')
  const real = join(dir, 'config.json')
  if (!(await exists(example)) || await exists(real)) return false
  await copyFile(example, real)
  return true
}

/**
 * Remove one installed skill directory.
 * @param config - the resolved plugin configuration.
 * @param skillName - skill name.
 * @returns `{ name, removed: true }`.
 */
async function removeSkill(config, skillName) {
  const nameValue = safeSkillName(skillName)
  const dir = join(resolveRoot(config), nameValue)
  await rm(dir, { recursive: true, force: true })
  return { name: nameValue, removed: true }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run a skill in a child Python process.
 *
 * `runner.py` loads the entry module as a package so relative imports
 * (`from ._impl import ...`) work, redirects stray prints to stderr, and emits a
 * single JSON envelope on stdout.
 *
 * @param config - the resolved plugin configuration.
 * @param skillName - skill name.
 * @param args - the `run(arguments)` payload.
 * @param options - cancellation.
 * @returns the runner's envelope.
 */
async function runSkill(config, skillName, args, { signal, cache } = {}) {
  const nameValue = safeSkillName(skillName)
  const root = resolveRoot(config)
  const skills = await scanSkills(root, cache ?? new Map())
  if (!skills.some((skill) => skill.name === nameValue)) throw new Error(`unknown skill "${nameValue}"`)

  const configured = String(readConfig(config, 'pythonPath', '') ?? '').trim()
  const python = configured.length > 0 ? configured : (process.platform === 'win32' ? 'python' : 'python3')
  const timeoutMs = Number(readConfig(config, 'runTimeoutMs', 60000))

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, [RUNNER, root, nameValue, JSON.stringify(args ?? {})], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
    const onAbort = () => {
      child.kill()
      finish(new Error('skill run aborted'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`skill "${nameValue}" timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`python exited ${String(code)}: ${stderr.trim().slice(-800)}`))
        return
      }
      let parsed
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        finish(new Error(`runner returned invalid JSON: ${stdout.trim().slice(0, 200)}`))
        return
      }
      finish(undefined, parsed)
    })
  })
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Build the `shellSkills` service.
 *
 * `list()` is the contract `dsh-inject-context` reads, so it stays deliberately
 * narrow: installed and enabled skills only, as `{ name, description }` with a
 * one-line description. Usage and execution are not part of it — the injector
 * publishes a pointer list, and a model that wants to know how to call a skill
 * asks the `shell_skill` tool (name-only, which answers with that skill's own
 * `# usage:` block). Keeping the two apart is what stops every session's
 * prompt from carrying argument documentation for skills nobody will use.
 * Everything else (`all`, `get`, `setStatus`, …) is the manager's vocabulary.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param state - shared scan state.
 * @returns the service object.
 */
function createService(ctx, config, state) {
  const refresh = async () => {
    state.skills = await scanSkills(resolveRoot(config), state.cache)
    return state.skills
  }
  return {
    /** Installed and enabled skills, the injection plugin's read face. */
    async list() {
      const skills = await refresh()
      return skills.filter(isEnabled).map(({ name: skillName, description }) => ({ name: skillName, description }))
    },
    /** Every installed skill, including disabled ones. */
    async all() {
      const skills = await refresh()
      return skills.map(({ name: skillName, description, status }) => ({ name: skillName, description, status: isEnabled({ status }) ? 'enable' : 'disable' }))
    },
    /** One skill's metadata. */
    async get(skillName) {
      const skills = await refresh()
      const found = skills.find((skill) => skill.name === skillName)
      if (!found) return undefined
      return {
        name: found.name,
        description: found.description,
        status: isEnabled({ status: found.status }) ? 'enable' : 'disable',
        usage: found.usage,
        path: found.path,
      }
    },
    /** Re-scan and return the full list. */
    async refresh() {
      const skills = await refresh()
      return skills.map(({ name: skillName, description, status }) => ({ name: skillName, description, status }))
    },
    /** Enable or disable a skill by rewriting its header. */
    async setStatus(skillName, status) {
      const updated = await setSkillStatus(resolveRoot(config), skillName, status, state.cache)
      return { name: updated.name, status: updated.status }
    },
    /** Install from the configured hub. */
    async install(skillName) {
      const installed = await installSkill(ctx, config, skillName)
      await refresh()
      return installed
    },
    /** Remove an installed skill. */
    async remove(skillName) {
      const removed = await removeSkill(config, skillName)
      state.cache.clear()
      await refresh()
      return removed
    },
    /** Run a skill and return its envelope. */
    async run(skillName, args, options) {
      return await runSkill(config, skillName, args, { ...options, cache: state.cache })
    },
    /** Remote index entries with an `installed` flag. */
    async listRemote() {
      const hub = hubOf(config)
      const token = await hubToken(ctx, config)
      const timeoutMs = Number(readConfig(config, 'installTimeoutMs', 30000))
      const entries = await fetchRemoteIndex(hub, { token, timeoutMs })
      const installed = new Set((await refresh()).map((skill) => skill.name))
      return entries.map((entry) => ({
        name: String(entry?.name ?? '').trim(),
        description: String(entry?.description ?? ''),
        version: String(entry?.version ?? ''),
        installed: installed.has(String(entry?.name ?? '').trim()),
      })).filter((entry) => entry.name.length > 0)
    },
  }
}

// ---------------------------------------------------------------------------
// Settings bridge (the manager card's only channel)
// ---------------------------------------------------------------------------

/**
 * The live config of the sibling state entry, when it is mounted.
 *
 * The state document is owned by `dsh-shell-skills/state`; `ctx.get` is used
 * rather than a hard dependency so this plugin still starts (with the card's
 * state empty for one tick) while the entries settle.
 *
 * @param ctx - the plugin context.
 * @returns the state config, or undefined.
 */
function stateConfigOf(ctx) {
  try {
    return ctx.get(STATE_SERVICE)?.config
  } catch {
    return undefined
  }
}

/**
 * Write volatile state fields, when the deployment exposes the service.
 *
 * State goes to its own namespace on purpose: a write here must not bump the
 * revision of the editable form, or an open form would fail its save fence
 * every time the manager mirrored an install.
 *
 * @param ctx - the plugin context.
 * @param patch - fields to merge.
 * @returns whether the write succeeded.
 */
async function updateSettings(ctx, patch) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.update !== 'function') return false
  try {
    await settings.update(STATE_NS, patch)
    return true
  } catch (error) {
    ctx.logger?.warn?.(`${name}: state update failed (${String(error)})`)
    return false
  }
}

/** Serialize the installed list for the card. */
function installedJsonOf(skills) {
  return JSON.stringify(skills.map(({ name: skillName, description, status }) => ({
    name: skillName,
    description,
    status: isEnabled({ status }) ? 'enable' : 'disable',
  })))
}

/**
 * Flip one entry's `installed` flag in the mirrored remote list.
 *
 * Returns `undefined` when there is no remote snapshot or the flag already
 * matches, so the caller can skip the state write entirely.
 *
 * @param stateConfig - the live config of the state entry.
 * @param skillName - the skill whose flag changed.
 * @param installed - the new flag.
 * @returns the updated JSON, or undefined.
 */
function patchRemoteFlags(stateConfig, skillName, installed) {
  const raw = String(readConfig(stateConfig, 'remoteJson', '') ?? '')
  if (raw.length === 0) return undefined
  let list
  try {
    list = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  let changed = false
  const next = list.map((entry) => {
    if (entry?.name !== skillName) return entry
    if (entry.installed === installed) return entry
    changed = true
    return { ...entry, installed }
  })
  return changed ? JSON.stringify(next) : undefined
}

/**
 * Mirror the installed list into the state document when it changed.
 * @param ctx - the plugin context.
 * @param state - shared scan state.
 */
async function publishInstalled(ctx, state) {
  const stateConfig = stateConfigOf(ctx)
  const json = installedJsonOf(state.skills)
  if (json === String(readConfig(stateConfig, 'installedJson', ''))) return
  await updateSettings(ctx, { installedJson: json })
}

/**
 * Perform one pending manager action, if the card queued a new one.
 *
 * The action id makes the channel idempotent: the card saves a fresh id, the
 * Host performs it once, records `lastActionId`, and the card's state refresh
 * follows the settings write.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param state - shared scan state.
 * @param service - the `shellSkills` service.
 */
async function handlePendingAction(ctx, config, state, service) {
  const stateConfig = stateConfigOf(ctx)
  const raw = String(readConfig(stateConfig, 'pendingAction', '') ?? '').trim()
  if (raw.length === 0) return
  let action
  try {
    action = JSON.parse(raw)
  } catch {
    return
  }
  const id = String(action?.id ?? '').trim()
  if (id.length === 0 || id === String(readConfig(stateConfig, 'lastActionId', ''))) return

  // An action that has been waiting far longer than any request can take was
  // queued while the manager was not running (or the switch was off). Retire it
  // instead of replaying stale intent hours later; the card's own 30-second
  // grace already stopped showing "working" for it.
  const requestedAt = Number(action?.at ?? 0)
  if (Number.isFinite(requestedAt) && requestedAt > 0 && Date.now() - requestedAt > 10 * 60 * 1000) {
    await updateSettings(ctx, {
      lastActionId: id,
      statusJson: JSON.stringify({ ok: false, action: action.type, message: 'expired before it could run', at: Date.now() }),
    })
    return
  }

  let result
  try {
    switch (action.type) {
      case 'install':
        result = await service.install(action.name)
        break
      case 'remove':
        result = await service.remove(action.name)
        break
      case 'enable':
        result = await service.setStatus(action.name, 'enable')
        break
      case 'disable':
        result = await service.setStatus(action.name, 'disable')
        break
      case 'refreshRemote':
        result = await service.listRemote()
        await updateSettings(ctx, { remoteJson: JSON.stringify(result) })
        break
      case 'refresh':
        result = await service.refresh()
        break
      default:
        throw new Error(`unknown action "${String(action.type)}"`)
    }
    state.skills = await scanSkills(resolveRoot(config), state.cache)
    const patch = {
      lastActionId: id,
      installedJson: installedJsonOf(state.skills),
      statusJson: JSON.stringify({ ok: true, action: action.type, message: `done: ${String(action.type)}`, at: Date.now() }),
    }
    // Keep the remote list's "installed" flags in step with the action, so the
    // card does not keep offering a download for something it just installed
    // (and does not show "installed" for something it just removed).
    if ((action.type === 'install' || action.type === 'remove') && typeof action.name === 'string') {
      const remote = patchRemoteFlags(stateConfig, action.name, action.type === 'install')
      if (remote !== undefined) patch.remoteJson = remote
    }
    // Retire the command once it is acknowledged, but only when the profile
    // still holds THIS action: the card may have queued a newer one while this
    // one ran, and clearing that would lose it.
    if (stillPending(stateConfig, id)) patch.pendingAction = ''
    await updateSettings(ctx, patch)
  } catch (error) {
    const patch = {
      lastActionId: id,
      statusJson: JSON.stringify({ ok: false, action: action.type, message: String(error?.message ?? error), at: Date.now() }),
    }
    if (stillPending(stateConfig, id)) patch.pendingAction = ''
    await updateSettings(ctx, patch)
  }
}

/**
 * Whether the state document's queued action is still the one identified by
 * `id`.
 * @param stateConfig - the live config of the state entry.
 * @param id - the acknowledged action id.
 * @returns true when the command can safely be cleared.
 */
function stillPending(stateConfig, id) {
  const current = String(readConfig(stateConfig, 'pendingAction', '') ?? '')
  return current.includes(id)
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/**
 * The model-facing `shell_skill` tool.
 *
 * It deliberately mirrors shell-tool's single `skill` tool: `all` lists,
 * `skill` without `arguments` returns usage, and `skill` with `arguments` runs
 * the skill. The extra `action`/`name` pair drives installation and status from
 * a conversation, so the manager does not have to be the only path.
 *
 * A name-only call is a "how do I use this" call, so its answer is the skill's
 * own `# usage:` block and nothing else — no description, no status, no fence.
 * The caller asked how to call the skill with its arguments; wrapping the
 * header in markup or field noise only dilutes that.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param state - shared scan state.
 * @param service - the `shellSkills` service.
 * @returns the tool definition.
 */
function createTool(ctx, config, state, service, defineTool) {
  return defineTool({
    name: 'shell_skill',
    description: 'List, inspect, install, enable/disable, remove, or run a shell skill. Call with all=true to list enabled skills, with skill="<name>" to read that skill\'s usage text, or with skill and arguments to execute it. Use action to manage installs.',
    parameters: {
      all: { type: 'boolean', description: 'List every enabled skill and its description.' },
      skill: { type: 'string', description: 'Skill name. Without arguments this returns its usage; with arguments it runs the skill.' },
      arguments: {
        type: 'object',
        additionalProperties: true,
        description: 'Arguments passed to the skill\'s run(arguments).',
      },
      action: {
        type: 'string',
        enum: ['install', 'remove', 'enable', 'disable', 'listRemote', 'refresh'],
        description: 'Manager action to perform; needs name for install/remove/enable/disable.',
      },
      name: { type: 'string', description: 'Target skill name for a manager action.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          result: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args, exec) {
      const asResult = (value) => ({
        status: 'ok',
        result: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      })

      if (args.action !== undefined) {
        switch (args.action) {
          case 'install':
            return asResult(await service.install(args.name))
          case 'remove':
            return asResult(await service.remove(args.name))
          case 'enable':
            return asResult(await service.setStatus(args.name, 'enable'))
          case 'disable':
            return asResult(await service.setStatus(args.name, 'disable'))
          case 'listRemote': {
            const remote = await service.listRemote()
            await updateSettings(ctx, { remoteJson: JSON.stringify(remote) })
            return asResult({ count: remote.length, skills: remote })
          }
          case 'refresh':
            return asResult(await service.refresh())
          default:
            throw new Error(`unknown action "${args.action}"`)
        }
      }
      if (args.all === true) {
        const skills = await service.all()
        return asResult({
          count: skills.length,
          skills: Object.fromEntries(skills.filter((skill) => skill.status === 'enable').map((skill) => [skill.name, skill.description])),
        })
      }
      if (typeof args.skill === 'string' && args.skill.length > 0) {
        if (args.arguments !== undefined) {
          return asResult(await service.run(args.skill, args.arguments, { signal: exec.signal }))
        }
        const meta = await service.get(args.skill)
        if (!meta) throw new Error(`unknown skill "${args.skill}"`)
        // Usage only: the caller asked how to call the skill, and the answer is
        // the skill's own header block, passed through as-is.
        return asResult(meta.usage.length > 0 ? meta.usage : `(skill "${meta.name}" declares no usage)`)
      }
      const enabled = await service.list()
      const names = enabled.map((skill) => skill.name).sort()
      return asResult([
        'shell skill collection (auto-registered from the skill root):',
        '  - list all enabled skills: all=true',
        '  - read usage: skill="<name>" without arguments',
        '  - run: skill="<name>" with arguments={...}',
        '  - manage: action=install|remove|enable|disable|listRemote|refresh, name="<name>"',
        `enabled skills: ${names.length > 0 ? names.join(', ') : '(none)'}`,
      ].join('\n'))
    },
  })
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Mount the manager.
 * @param ctx - the Cordis context owning this plugin.
 * @param rawConfig - the resolved Config.
 * @returns a disposer that stops the sync loop and withdraws the service.
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig
  /** Shared scan memo: path → `{ mtimeMs, size, meta }`. */
  const state = { skills: [], cache: new Map() }
  const service = createService(ctx, config, state)

  // Published synchronously: the context injection plugin may read it during
  // its own mount, before the first scan completes. Its `list()` scans lazily.
  // Each optional registration is isolated: a registry that is not visible (or
  // that rejects this tool) must not stop the manager and the settings card.
  try {
    ctx.provide(SERVICE, service)
  } catch (error) {
    ctx.logger?.warn?.(`${name}: could not publish ${SERVICE} (${String(error)})`)
  }
  /**
   * Register the tool once the registry is visible.
   *
   * Everything here is deferred and failure-tolerant on purpose: the settings
   * manager and the `shellSkills` service must start even when the tool
   * registry or `@deepseek-ai/dsh-tools` cannot be resolved. A static import of
   * that package would turn a resolution problem into a dead plugin.
   */
  let toolRegistered = false
  async function ensureTool() {
    if (toolRegistered) return
    let registry
    try {
      registry = (typeof ctx.get === 'function' ? ctx.get('tools') : undefined) ?? ctx.tools
    } catch {
      return
    }
    if (registry === undefined || registry === null || typeof registry.register !== 'function') return
    try {
      const mod = await import('@deepseek-ai/dsh-tools')
      const defineTool = mod.defineTool
      if (typeof defineTool !== 'function') throw new Error('defineTool is missing')
      registry.register(createTool(ctx, config, state, service, defineTool))
      toolRegistered = true
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not register shell_skill (${String(error)})`)
    }
  }
  void ensureTool()

  let ticking = false
  /**
   * One manager tick: refresh the scan, mirror it, then run a pending action.
   *
   * The master switch gates periodic scanning only. A queued action is an
   * explicit user request and must still run — otherwise a refresh queued just
   * before the switch was turned off would sit in `pendingAction` forever and
   * leave the card stuck on "working".
   *
   * A single in-flight tick keeps the one-second cadence from overlapping.
   */
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      // A registry that appears after mount still gets the tool, and a failed
      // dynamic import is retried instead of silently disabling the tool until
      // the next restart.
      void ensureTool()
      if (readConfig(config, 'enabled', true) !== false) {
        state.skills = await scanSkills(resolveRoot(config), state.cache)
        await publishInstalled(ctx, state)
      }
      await handlePendingAction(ctx, config, state, service)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: manager tick failed (${String(error)})`)
    } finally {
      ticking = false
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, 1000)

  let released = false
  return () => {
    if (released) return
    released = true
    clearInterval(timer)
  }
}