/**
 * dsh-shell-skills — browser half.
 *
 * Registers the manager card on the Plugins page. The card edits the hub
 * settings through the shared form model and drives manager actions through
 * the namespace's own volatile fields:
 *
 *   card button → scope.mutate({ pendingAction: { id, type, name } })
 *   Host tick   → performs it → writes installedJson / statusJson / lastActionId
 *   Host write  → scope.subscribe → the card re-renders the lists
 *
 * This indirection exists because an out-of-tree plugin cannot add a
 * `ctx.remote.*` namespace: the client capability set is fixed at build time by
 * `@deepseek-ai/dsh-api-remotes`. Settings fields are the only private channel
 * both halves already share.
 *
 * @module dsh-shell-skills/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-shell-skills',
  factory: (require) => {
    const { jsx, jsxs } = require('react/jsx-runtime')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const module = { exports: {} }
    const exports = module.exports

    /** Profile entry id; also the settings namespace and slot key. */
    const NS = 'dsh-shell-skills'

    /** Dictionary namespace owned by this card. */
    const LOCALE_NS = 'settings.shellSkills'

    /** Local status shown when the Host refuses the action write. */
    const WRITE_FAILED = 'write-failed'

    const en = {
      title: 'Shell skills',
      description: 'Run shell-tool style Python skills and manage their installs.',
      enabled: 'Enable shell skills',
      enabledHint: 'When off, the manager stops syncing and the shell_skill tool reports an empty list.',
      hubSection: 'Remote repository',
      hubType: 'Repository kind',
      hubTypeHint: 'GitHub uses raw.githubusercontent.com; Gitea uses the base URL below.',
      hubBase: 'Gitea base URL',
      hubBaseHint: 'For example http://192.168.30.181:3000. Ignored for GitHub.',
      hubRepo: 'Repository',
      hubRepoHint: 'owner/repo, for example abc12524/shell-skills.',
      hubBranch: 'Branch',
      hubBranchHint: 'Defaults to main.',
      installedSection: 'Installed skills',
      installedEmpty: 'No skills installed yet. Pull the remote list and download one.',
      remoteSection: 'Remote skills',
      remoteEmpty: 'Remote list not loaded yet.',
      refreshRemote: 'Refresh remote list',
      install: 'Download',
      installed: 'Installed',
      enable: 'Enable',
      disable: 'Disable',
      remove: 'Remove',
      statusEnable: 'enabled',
      statusDisable: 'disabled',
      working: 'Working…',
      lastResult: 'Last action',
      writeFailed: 'The deployment did not accept the action; nothing was changed.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
    }

    const zh = {
      title: 'Shell skills',
      description: '运行 shell-tool 风格的 Python skill，并管理安装、启用与卸载。',
      enabled: '启用 shell skills',
      enabledHint: '关闭后不再同步管理状态，shell_skill 工具会返回空列表。',
      hubSection: '远程仓库',
      hubType: '仓库类型',
      hubTypeHint: 'GitHub 走 raw.githubusercontent.com；Gitea 使用下面的基址。',
      hubBase: 'Gitea 基址',
      hubBaseHint: '例如 http://192.168.30.181:3000。GitHub 不使用此项。',
      hubRepo: '仓库',
      hubRepoHint: 'owner/repo，例如 abc12524/shell-skills。',
      hubBranch: '分支',
      hubBranchHint: '默认 main。',
      installedSection: '已安装 skill',
      installedEmpty: '还没有安装任何 skill。先拉取远程列表，再下载一个。',
      remoteSection: '远程 skill',
      remoteEmpty: '尚未加载远程列表。',
      refreshRemote: '刷新远程列表',
      install: '下载',
      installed: '已安装',
      enable: '启用',
      disable: '禁用',
      remove: '卸载',
      statusEnable: '已启用',
      statusDisable: '已禁用',
      working: '处理中…',
      lastResult: '最近操作',
      writeFailed: '本部署没有接受该操作，未做任何修改。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。',
    }

    /** Labels the shared settings form renders. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /** A text field whose stored value is a plain string. */
    function textField(field) {
      return {
        field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => ({ kind: 'set', value: text }),
      }
    }

    /** A two-choice field staged as text and edited by a segmented control. */
    const hubTypeField = {
      field: 'hubType',
      format: (value) => (value === 'gitea' ? 'gitea' : 'github'),
      parse: (text) => ({ kind: 'set', value: text === 'gitea' ? 'gitea' : 'github' }),
    }

    /** Same gate as the host's `enabled` switch. */
    const enabledField = {
      field: 'enabled',
      format: (value) => (value === false ? 'off' : 'on'),
      parse: (text) => ({ kind: 'set', value: text === 'on' }),
    }

    /** Parse a JSON state field, falling back to `fallback`. */
    function parseJson(value, fallback) {
      if (typeof value !== 'string' || value.length === 0) return fallback
      try {
        const parsed = JSON.parse(value)
        return parsed ?? fallback
      } catch {
        return fallback
      }
    }

    /** Card controller: owns the form, the state projection, and action writes. */
    class CardController {
      /**
       * @param scope - the bound settings scope for this namespace.
       * @param ctx - the page plugin context.
       */
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        this.busy = false
        this.writeFailed = false
        this.form = new P.SettingsFormModel(scope, [
          enabledField,
          hubTypeField,
          textField('hubBase'),
          textField('hubRepo'),
          textField('hubBranch'),
        ])
        this.store = this.form.bind(() => this.projection())
      }

      /** Build the snapshot the card reads. */
      projection() {
        const snapshot = this.scope.getSnapshot()
        const value = snapshot?.value ?? {}
        const pending = parseJson(value.pendingAction, null)
        const lastId = typeof value.lastActionId === 'string' ? value.lastActionId : ''
        const actionPending = pending !== null
          && typeof pending === 'object'
          && typeof pending.id === 'string'
          && pending.id !== lastId
        return {
          ...this.form.shell(),
          enabled: this.form.field('enabled').text !== 'off',
          enabledField: this.form.field('enabled'),
          hubType: this.form.field('hubType'),
          hubBase: this.form.field('hubBase'),
          hubRepo: this.form.field('hubRepo'),
          hubBranch: this.form.field('hubBranch'),
          installed: parseJson(value.installedJson, []),
          remote: parseJson(value.remoteJson, []),
          status: parseJson(value.statusJson, null),
          busy: this.busy || actionPending,
          writeFailed: this.writeFailed,
        }
      }

      /**
       * Ask the Host to perform one manager action.
       * @param type - action verb the Host understands.
       * @param name - target skill, when the verb needs one.
       */
      async runAction(type, name) {
        const revision = this.scope.getSnapshot()?.revision
        const action = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type,
          ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
        }
        this.busy = true
        this.writeFailed = false
        this.store.set(this.projection())
        let accepted = false
        try {
          accepted = await this.scope.mutate(
            [{ op: 'set', path: ['pendingAction'], value: JSON.stringify(action) }],
            revision,
          )
        } catch {
          accepted = false
        }
        this.busy = false
        this.writeFailed = !accepted
        this.store.set(this.projection())
      }

      /** The face the plugin's slot registration injects. */
      inject() {
        return {
          hooks: { injectShellSkillsCard: this.store },
          ...this.form.actions(),
          runAction: (type, name) => this.runAction(type, name),
        }
      }

      /** Release subscriptions. */
      dispose() {
        this.form.dispose()
      }
    }

    /** One inline style shared by the list rows. */
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      padding: '6px 0',
      borderBottom: '1px solid rgba(127, 127, 127, 0.18)',
    }

    /** Section heading. */
    const headingStyle = { margin: '14px 0 4px', fontWeight: 600 }

    /** Render the card. */
    function ShellSkillsCard(props) {
      const { t } = props
      const state = props.useShellSkillsCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')
      const disabled = !state.writable || state.busy

      const installedRows = state.installed.length === 0
        ? [jsx('div', { key: 'empty', style: { opacity: 0.7 }, children: t('installedEmpty') })]
        : state.installed.map((skill) => jsxs('div', {
          key: skill.name,
          style: rowStyle,
          children: [
            jsxs('div', {
              children: [
                jsx('span', { children: skill.name }),
                jsx('span', { style: { marginLeft: '8px', opacity: 0.65, fontSize: '12px' }, children: skill.description }),
              ],
            }),
            jsxs('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, children: [
              jsx(P.Tag, {
                tone: skill.status === 'enable' ? 'success' : 'quiet',
                children: skill.status === 'enable' ? t('statusEnable') : t('statusDisable'),
              }),
              jsx(P.Button, {
                size: 'sm',
                variant: 'outline',
                disabled,
                onClick: () => { props.runAction(skill.status === 'enable' ? 'disable' : 'enable', skill.name) },
                children: skill.status === 'enable' ? t('disable') : t('enable'),
              }),
              jsx(P.Button, {
                size: 'sm',
                variant: 'ghost',
                disabled,
                onClick: () => { props.runAction('remove', skill.name) },
                children: t('remove'),
              }),
            ] }),
          ],
        }))

      const remoteRows = state.remote.length === 0
        ? [jsx('div', { key: 'empty', style: { opacity: 0.7 }, children: t('remoteEmpty') })]
        : state.remote.map((skill) => jsxs('div', {
          key: skill.name,
          style: rowStyle,
          children: [
            jsxs('div', {
              children: [
                jsx('span', { children: skill.name }),
                jsx('span', { style: { marginLeft: '8px', opacity: 0.65, fontSize: '12px' }, children: skill.description }),
              ],
            }),
            jsx(P.Button, {
              size: 'sm',
              variant: skill.installed ? 'ghost' : 'primary',
              disabled: disabled || skill.installed,
              onClick: () => { props.runAction('install', skill.name) },
              children: skill.installed ? t('installed') : t('install'),
            }),
          ],
        }))

      return jsxs(P.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          jsx(P.Switch, {
            checked: state.enabled,
            disabled: !state.writable,
            label: t('enabled'),
            title: t('enabledHint'),
            onChange: (next) => { props.edit('enabled', next ? 'on' : 'off') },
          }),
          jsx('div', { style: headingStyle, children: t('hubSection') }),
          jsx(P.SegmentedControl, {
            id: 'shell-skills-hub-type',
            label: t('hubType'),
            value: state.hubType.text === 'gitea' ? 'gitea' : 'github',
            options: [
              { value: 'github', label: 'GitHub' },
              { value: 'gitea', label: 'Gitea' },
            ],
            onChange: (next) => { props.edit('hubType', next) },
            disabled: disabled,
          }),
          jsx(P.SettingsValueField, {
            id: 'shell-skills-hub-base',
            label: t('hubBase'),
            hint: t('hubBaseHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.hubBase,
            onEdit: (text) => { props.edit('hubBase', text) },
            onReset: () => { props.resetField('hubBase') },
          }),
          jsx(P.SettingsValueField, {
            id: 'shell-skills-hub-repo',
            label: t('hubRepo'),
            hint: t('hubRepoHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.hubRepo,
            onEdit: (text) => { props.edit('hubRepo', text) },
            onReset: () => { props.resetField('hubRepo') },
          }),
          jsx(P.SettingsValueField, {
            id: 'shell-skills-hub-branch',
            label: t('hubBranch'),
            hint: t('hubBranchHint'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalidNumber'),
            disabled,
            ...state.hubBranch,
            onEdit: (text) => { props.edit('hubBranch', text) },
            onReset: () => { props.resetField('hubBranch') },
          }),
          jsx('div', { style: headingStyle, children: t('installedSection') }),
          ...installedRows,
          jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0 4px' }, children: [
            jsx('span', { style: headingStyle, children: t('remoteSection') }),
            jsx(P.Button, {
              size: 'sm',
              variant: 'outline',
              disabled,
              onClick: () => { props.runAction('refreshRemote') },
              children: t('refreshRemote'),
            }),
          ] }),
          ...remoteRows,
          state.busy
            ? jsx('div', { style: { marginTop: '10px', opacity: 0.8 }, children: t('working') })
            : null,
          state.writeFailed
            ? jsx('div', { style: { marginTop: '10px', color: 'var(--dsw-alias-text-danger, #d9534f)' }, children: t('writeFailed') })
            : null,
          state.status
            ? jsx('div', { style: { marginTop: '10px', opacity: 0.85, fontSize: '12px' }, children: `${t('lastResult')}: ${state.status.ok ? 'ok' : 'error'} — ${state.status.message ?? ''}` })
            : null,
        ],
      })
    }

    /** Required client services. */
    const inject = ['slots', 'locale', 'configForms']

    /** Mount the manager card while the Host serves this namespace. */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { zh, en }),
        'dsh-shell-skills: dictionaries',
      )
      const scope = ctx.configForms.get(NS)
      const card = new CardController(scope, ctx)
      ctx.effect(() => () => { card.dispose() }, 'dsh-shell-skills: form subscription')
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: NS,
                  label: () => t('title'),
                  locale: LOCALE_NS,
                  inject: () => card.inject(),
                },
                ShellSkillsCard,
              ),
            ),
          ),
        'dsh-shell-skills: settings page',
      )
    }

    exports.NS = LOCALE_NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})