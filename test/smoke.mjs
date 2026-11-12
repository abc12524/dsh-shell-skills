/**
 * Self-check for dsh-shell-skills.
 *
 * Runs the real Host half against a temporary skill root: header parsing,
 * enable/disable rewriting, the GitHub Contents download path (stubbed fetch),
 * a real Python run, the tool's argument routing, and the settings round-trip
 * the manager card uses. The browser half is loaded through the Client module
 * loader envelope and its action write is verified against a fake scope.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, apply, inject, name } from '../lib/index.js'
import { Config as StateConfig } from '../lib/state.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-shell-skills-'))
const realFetch = globalThis.fetch
let fetchCalls = []
let fetchImpl = async () => new Response('{}', { status: 404 })
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init })
  return await fetchImpl(String(url), init)
}

/** Build a minimal Cordis-like context. */
function makeCtx({ settings, credentials } = {}) {
  const listeners = []
  const logs = []
  const services = new Map()
  const registered = []
  return {
    listeners,
    logs,
    services,
    registered,
    on(event, handler, options) {
      listeners.push({ event, handler, options })
      return () => {
        const index = listeners.findIndex((listener) => listener.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    get(service) {
      if (service === 'settings') return settings
      if (service === 'credentials') return credentials
      return services.get(service)
    },
    provide(service, value) {
      services.set(service, value)
      return () => { services.delete(service) }
    },
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
  }
}

const BASE_CONFIG = { root, pythonPath: process.platform === 'win32' ? 'python' : 'python3', runTimeoutMs: 20000 }

/**
 * Mount one instance.
 * @param overrides - Config overrides.
 * @param options - `{ settings, credentials }` services.
 */
function mount(overrides = {}, options = {}) {
  const ctx = makeCtx(options)
  const config = Config({ ...BASE_CONFIG, ...overrides })
  const stateConfig = StateConfig({})
  ctx.provide('shellSkillsState', { config: stateConfig, namespace: 'dsh-shell-skills-state' })
  const dispose = apply(ctx, config)
  return {
    ctx,
    config,
    stateConfig,
    dispose,
    service: ctx.services.get('shellSkills'),
    tool: ctx.registered[0],
  }
}

/** Write one skill folder. */
async function writeSkill(folder, { skillName, description = '', status, usage = '', body = '', helper = '' }) {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'skill.py'), [
    `# skill: ${skillName ?? folder}`,
    description ? `# description: ${description}` : '',
    status ? `# status: ${status}` : '',
    usage ? `# usage: ${usage}` : '',
    '',
    body || 'def run(arguments):\n    return {"ok": True}\n',
  ].filter((line) => line !== '').join('\n'), 'utf8')
  if (helper) await writeFile(join(dir, '_impl.py'), helper, 'utf8')
  return dir
}

console.log(`fixture: ${root}\n`)

// ---------------------------------------------------------------------------
// Case 1 — the exported config shape the settings form projects.
// ---------------------------------------------------------------------------

assert.equal(name, 'dsh-shell-skills')
assert.deepEqual(inject, [], 'every service is optional so a missing registry cannot keep the plugin pending')
assert.equal(Config.type, 'object')

const VOLATILE_FIELDS = ['enabled', 'hubType', 'hubBase', 'hubRepo', 'hubBranch']
const ORDINARY_FIELDS = ['root', 'pythonPath', 'runTimeoutMs', 'installTimeoutMs', 'hubTokenRef']
const STATE_FIELDS = ['installedJson', 'remoteJson', 'statusJson', 'pendingAction', 'lastActionId']

for (const field of VOLATILE_FIELDS) {
  assert.equal(Config.dict[field]?.meta?.volatile, true, `${field} must be volatile to reach the manager card`)
}
for (const field of ORDINARY_FIELDS) {
  assert.notEqual(Config.dict[field]?.meta?.volatile, true, `${field} is operational configuration, not a form field`)
}
for (const field of STATE_FIELDS) {
  assert.equal(Config.dict[field], undefined, `${field} must not share the form document`)
  assert.equal(StateConfig.dict[field]?.meta?.volatile, true, `${field} is volatile on the state entry`)
}
assert.equal(Config.dict.hubTokenRef?.meta?.role, 'credential-ref', 'the hub token is a credential reference')
assert.equal(Object.values(Config.dict).some((child) => child.meta?.role === 'secret'), false, 'no secret literals')
console.log('case 1  ok  Config: the form and the state document are separate')

// ---------------------------------------------------------------------------
// Case 2 — scanning, list/all/get.
// ---------------------------------------------------------------------------

{
  await writeSkill('alpha', { description: 'first skill' })
  await writeSkill('beta', { description: 'second skill', status: 'disable' })
  await writeSkill('_helper', { description: 'not a skill' })
  await mkdir(join(root, 'nohead'), { recursive: true })
  await writeFile(join(root, 'nohead', 'skill.py'), 'print("no header")\n', 'utf8')

  const { service, dispose } = mount()
  try {
    const listed = await service.list()
    assert.deepEqual(listed, [{ name: 'alpha', description: 'first skill' }], 'list returns enabled skills only')
    const all = await service.all()
    assert.equal(all.length, 2, 'all includes the disabled skill')
    assert.equal(all.find((skill) => skill.name === 'beta').status, 'disable')
    const got = await service.get('alpha')
    assert.equal(got.description, 'first skill')
    assert.match(got.path, /skill\.py$/)
    assert.equal(await service.get('_helper'), undefined, 'helper folders never register')
    assert.equal(await service.get('nohead'), undefined, 'a file without a # skill header never registers')
    console.log('case 2  ok  scan registers declared skills, skips helpers and headerless files')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 3 — status rewrite preserves BOM and CRLF and flips list visibility.
// ---------------------------------------------------------------------------

{
  const dir = await writeSkill('crlf', { description: 'crlf skill', status: 'enable' })
  const path = join(dir, 'skill.py')
  const source = await readFile(path, 'utf8')
  await writeFile(path, Buffer.from(`\uFEFF${source.replace(/\n/g, '\r\n')}`, 'utf8'))

  const { service, dispose } = mount()
  try {
    await service.setStatus('crlf', 'disable')
    const raw = await readFile(path)
    assert.deepEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'the BOM is preserved')
    assert.ok(raw.toString('utf8').includes('\r\n'), 'CRLF line endings are preserved')
    assert.match(raw.toString('utf8'), /# status: disable/, 'the header is rewritten in place')
    assert.equal((await service.list()).some((skill) => skill.name === 'crlf'), false)
    await service.setStatus('crlf', 'enable')
    assert.equal((await service.list()).some((skill) => skill.name === 'crlf'), true)
    await assert.rejects(() => service.setStatus('crlf', 'maybe'), /must be enable or disable/)
    await assert.rejects(() => service.setStatus('missing', 'disable'), /unknown skill/)
    console.log('case 3  ok  setStatus rewrites the header, preserves BOM/CRLF, and gates list()')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 4 — install through the GitHub Contents API.
// ---------------------------------------------------------------------------

{
  const SKILL_PY = '# skill: demo\n# description: remote demo\n\ndef run(arguments):\n    return {"demo": True}\n'
  const EXAMPLE = '{"DEMO_KEY": "change-me"}\n'
  const BASE = 'https://api.github.com/repos/abc12524/shell-skills/contents/skills/demo?ref=main'

  fetchCalls = []
  fetchImpl = async (url) => {
    if (url.includes('/index.json')) {
      return jsonResponse({ skills: [{ name: 'demo', description: 'remote demo', path: 'skills/demo' }] })
    }
    if (url === BASE) {
      return jsonResponse([
        { name: 'skill.py', type: 'file', download_url: 'https://raw.example/demo/skill.py' },
        { name: 'config.example.json', type: 'file', download_url: 'https://raw.example/demo/config.example.json' },
      ])
    }
    if (url === 'https://raw.example/demo/skill.py') return textResponse(SKILL_PY)
    if (url === 'https://raw.example/demo/config.example.json') return textResponse(EXAMPLE)
    return new Response('missing', { status: 404 })
  }

  const { service, dispose } = mount()
  try {
    const installed = await service.install('demo')
    assert.equal(installed.name, 'demo')
    assert.equal(await readFile(join(root, 'demo', 'skill.py'), 'utf8'), SKILL_PY)
    assert.equal(await readFile(join(root, 'demo', 'config.json'), 'utf8'), EXAMPLE, 'the example becomes the live config')
    assert.equal((await service.list()).some((skill) => skill.name === 'demo'), true)

    // A reinstall keeps the operator's real config.
    await writeFile(join(root, 'demo', 'config.json'), '{"DEMO_KEY": "real"}\n', 'utf8')
    await service.install('demo')
    assert.equal(await readFile(join(root, 'demo', 'config.json'), 'utf8'), '{"DEMO_KEY": "real"}\n')

    await assert.rejects(() => service.install('unknown'), /remote repository has no skill/)
    await assert.rejects(() => service.install('../escape'), /invalid skill name/)
    console.log('case 4  ok  install downloads the subtree and preserves local config')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 5 — remove.
// ---------------------------------------------------------------------------

{
  const { service, dispose } = mount()
  try {
    await service.remove('demo')
    await assert.rejects(() => stat(join(root, 'demo')))
    assert.equal((await service.list()).some((skill) => skill.name === 'demo'), false)
    console.log('case 5  ok  remove deletes the skill directory')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 6 — a real Python run, including a relative import.
// ---------------------------------------------------------------------------

{
  await writeSkill('runner', {
    description: 'python round trip',
    usage: 'runner {x: string} - echoes the value back',
    body: 'from ._impl import PREFIX\n\n\ndef run(arguments):\n    return {"echo": PREFIX + str(arguments.get("x", ""))}\n',
    helper: 'PREFIX = "seen:"\n',
  })
  const { service, dispose } = mount()
  try {
    const envelope = await service.run('runner', { x: 'hi' })
    assert.equal(envelope.status, 'ok')
    assert.equal(envelope.result.echo, 'seen:hi', 'relative imports resolve inside the skill folder')
    await assert.rejects(() => service.run('missing', {}), /unknown skill/)
    console.log('case 6  ok  run executes in a child Python process with relative imports')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 6b — shared shell-skills resolve `from _envelope import ok, error`.
// ---------------------------------------------------------------------------

{
  await writeSkill('shimmed', {
    description: 'envelope shim',
    body: [
      'from _envelope import ok, error',
      '',
      '',
      'def run(arguments):',
      '    if arguments.get("fail"):',
      '        return error("boom", code="exploded")',
      '    return ok({"echo": arguments.get("x", "")})',
      '',
    ].join('\n'),
  })
  const { service, dispose } = mount()
  try {
    const envelope = await service.run('shimmed', { x: 'hi' })
    assert.equal(envelope.status, 'ok')
    const inner = JSON.parse(envelope.result)
    assert.deepEqual(inner, { status: 'ok', result: { echo: 'hi' } })

    const failed = await service.run('shimmed', { fail: true })
    assert.equal(failed.status, 'ok', 'a skill-level error is still a successful run')
    const innerError = JSON.parse(failed.result)
    assert.equal(innerError.status, 'error')
    assert.equal(innerError.code, 'exploded')
    console.log('case 6b ok  shared shell-skills resolve _envelope through the runner shim')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 7 — the shell_skill tool routes list / usage / run / manager actions.
// ---------------------------------------------------------------------------

{
  const mounted = mount()
  // The tool is registered after the dynamic `@deepseek-ai/dsh-tools` import.
  await new Promise((resolve) => setTimeout(resolve, 200))
  const { service, dispose } = mounted
  const tool = mounted.ctx.registered[0]
  assert.ok(tool, 'the tool is registered asynchronously')
  const exec = { signal: new AbortController().signal }
  try {
    const listed = await tool.execute({ all: true }, exec)
    assert.equal(listed.status, 'ok')
    const listedValue = JSON.parse(listed.result)
    assert.ok(listedValue.skills.runner, 'enabled skills are listed by name')
    assert.equal(listedValue.skills.beta, undefined, 'disabled skills stay out of the disclosure')

    const usage = await tool.execute({ skill: 'runner' }, exec)
    assert.equal(
      usage.result,
      '<user-reminder>\nrunner {x: string} - echoes the value back\n</user-reminder>',
      'a name-only call returns the usage header alone, fenced, with no envelope',
    )
    // A skill without a usage header still answers, with the fallback inside the
    // same fence.
    await writeSkill('no-usage', { description: 'silent skill' })
    await service.refresh()
    const bare = await tool.execute({ skill: 'no-usage' }, exec)
    assert.equal(bare.result, '<user-reminder>\n(skill "no-usage" declares no usage)\n</user-reminder>')

    const ran = await tool.execute({ skill: 'runner', arguments: { x: 'tool' } }, exec)
    assert.equal(JSON.parse(ran.result).result.echo, 'seen:tool')

    const disabled = await tool.execute({ action: 'disable', name: 'runner' }, exec)
    assert.equal(JSON.parse(disabled.result).status, 'disable')
    const reenabled = await tool.execute({ action: 'enable', name: 'runner' }, exec)
    assert.equal(JSON.parse(reenabled.result).status, 'enable')

    const help = await tool.execute({}, exec)
    assert.match(help.result, /shell skill collection/)
    assert.ok(service)
    console.log('case 7  ok  shell_skill routes list, usage, run, and status actions')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 8 — the card/Host settings round-trip and idempotent action ids.
// ---------------------------------------------------------------------------

{
  const patches = []
  const settings = {
    target: undefined,
    async update(ns, patch) {
      assert.equal(ns, 'dsh-shell-skills-state', 'state never shares the form document')
      patches.push(patch)
      if (this.target !== undefined) Object.assign(this.target, patch)
    },
  }
  await writeSkill('managed', { description: 'managed skill' })
  const { stateConfig, dispose } = mount({}, { settings })
  settings.target = stateConfig
  try {
    // Wait for the first tick to mirror the installed list.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.ok(patches.some((patch) => typeof patch.installedJson === 'string' && patch.installedJson.includes('managed')))

    const action = { id: 'action-1', type: 'disable', name: 'managed', at: Date.now() }
    stateConfig.pendingAction = JSON.stringify(action)
    await new Promise((resolve) => setTimeout(resolve, 1400))
    assert.equal(stateConfig.lastActionId, 'action-1', 'the action is recorded once')
    assert.equal(stateConfig.pendingAction, '', 'an acknowledged action is retired')
    assert.ok(patches.some((patch) => patch.statusJson?.includes('done')))
    assert.ok((await readFile(join(root, 'managed', 'skill.py'), 'utf8')).includes('# status: disable'))

    // The same id never runs twice.
    const before = patches.length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(patches.slice(before).some((patch) => patch.statusJson !== undefined), false, 'replayed ids are ignored')
    console.log('case 8  ok  pendingAction runs once in the state document and is retired')
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Case 9 — the browser half registers the page and writes pendingAction.
// ---------------------------------------------------------------------------

{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.startsWith('/**'), 'the bundle keeps its module documentation')

  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load: (loaded) => { definition = loaded },
    },
  }
  await import('../lib/client.js')

  assert.ok(definition, 'the bundle registers through window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-shell-skills')
  assert.equal(typeof definition.factory, 'function')

  const jsx = (type, props) => ({ type, props })
  class FakeFormModel {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = new Map(specs.map((spec) => [spec.field, spec]))
      this.values = {}
    }
    bind(project) {
      this.project = project
      return { set: () => {}, get: () => this.project() }
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(field) {
      const spec = this.specs.get(field)
      return { text: spec ? spec.format(this.values[field]) : '', overridden: false, invalid: false }
    }
    actions() {
      return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
    }
    dispose() {}
  }
  const primitives = {
    SettingsFormModel: FakeFormModel,
    SettingsForm: () => null,
    SettingsValueField: () => null,
    SegmentedControl: () => null,
    Switch: () => null,
    Tag: () => null,
    Button: () => null,
    settingsTextField: (field) => ({
      field,
      format: (value) => (typeof value === 'string' ? value : ''),
      parse: (text) => ({ kind: 'set', value: text }),
    }),
  }
  const mutations = []
  const snapshot = { status: 'ready', writable: true, revision: 3, value: {} }
  const stateSnapshot = { status: 'ready', writable: true, revision: 7, value: {} }
  const makeScope = (snap) => ({
    getSnapshot: () => snap,
    subscribe: () => () => {},
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      return true
    },
  })
  const scope = makeScope(snapshot)
  const stateScope = makeScope(stateSnapshot)
  const registered = []
  const clientCtx = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    configForms: {
      get: (ns) => {
        if (ns === 'dsh-shell-skills') return scope
        assert.equal(ns, 'dsh-shell-skills-state')
        return stateScope
      },
      whileServed: (keys, cb) => {
        assert.deepEqual(keys, ['dsh-shell-skills', 'dsh-shell-skills-state'])
        return cb()
      },
    },
    slots: {
      inject: (slotName, cb) => {
        assert.equal(slotName, 'plugins.bundle.config')
        return cb()
      },
      register: (entry, component) => {
        registered.push({ entry, component })
        return () => {}
      },
    },
  }
  const clientExports = definition.factory((id) => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${id}`)
  })

  assert.deepEqual(clientExports.inject, ['slots', 'locale', 'configForms'])
  clientExports.apply(clientCtx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].entry.key, 'dsh-shell-skills')
  assert.equal(registered[0].entry.locale, 'settings.shellSkills')
  assert.equal(typeof registered[0].entry.inject().hooks.shellSkillsCard, 'object')

  const summary = registered[0].component({
    view: 'summary',
    t: (key) => key,
    useShellSkillsCard: (select) => select({ installed: [], remote: [], status: null, busy: false, writeFailed: false }),
  })
  assert.equal(typeof summary, 'string')

  // A legacy action without a timestamp must not pin the card on "working":
  // this is what a stopped manager left behind before the timestamp existed.
  const store = registered[0].entry.inject().hooks.shellSkillsCard
  stateSnapshot.value = { pendingAction: JSON.stringify({ id: 'legacy', type: 'refreshRemote' }) }
  assert.equal(store.get().busy, false, 'a legacy action without a timestamp does not pin the card')
  stateSnapshot.value = {}

  // The full card: installed rows drive an on/off switch, remote rows use the
  // arrow-icon download button only when the skill is not installed.
  const field = (text) => ({ text, overridden: false, invalid: false })
  const rendered = registered[0].component({
    view: 'default',
    t: (key) => key,
    useShellSkillsCard: (select) => select({
      available: true,
      writable: true,
      dirty: false,
      invalid: false,
      saving: false,
      failed: false,
      enabled: true,
      hubType: field('github'),
      hubBase: field(''),
      hubRepo: field('abc12524/shell-skills'),
      hubBranch: field('main'),
      installed: [{ name: 'alpha', description: 'first', status: 'enable' }],
      remote: [
        { name: 'beta', description: 'second', installed: false },
        { name: 'gamma', description: 'third', installed: true },
      ],
      status: null,
      busy: false,
      writeFailed: false,
    }),
    edit: () => {},
    resetField: () => {},
    save: () => {},
    discard: () => {},
    runAction: () => {},
  })
  const types = []
  const collectTypes = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) collectTypes(child)
      return
    }
    if (node.type !== undefined) {
      types.push(node.type)
      collectTypes(node.props?.children)
      collectTypes(node.props?.icon)
    }
  }
  collectTypes(rendered)
  assert.equal(types.filter((type) => type === primitives.Switch).length, 2, 'the master switch plus the installed row switch')
  assert.equal(types.filter((type) => type === 'svg').length, 1, 'only the not-installed row shows the download arrow')
  assert.equal(types.filter((type) => type === primitives.Button).length, 3, 'refresh, remove, and one arrow button')

  const injected = registered[0].entry.inject()
  await injected.runAction('remove', 'demo')
  assert.equal(mutations.length, 1)
  assert.deepEqual(mutations[0].revision, 7)
  assert.equal(mutations[0].ops[0].op, 'set')
  assert.deepEqual(mutations[0].ops[0].path, ['pendingAction'])
  const action = JSON.parse(mutations[0].ops[0].value)
  assert.equal(action.type, 'remove')
  assert.equal(action.name, 'demo')
  assert.ok(action.id.length > 0)
  console.log('case 9  ok  the card registers and writes a fresh pendingAction')
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

globalThis.fetch = realFetch
delete globalThis.window
await rm(root, { recursive: true, force: true })

console.log('\nall checks passed')

/** A JSON response helper. */
function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** A text response helper. */
function textResponse(value) {
  return new Response(value, { status: 200, headers: { 'content-type': 'text/plain' } })
}