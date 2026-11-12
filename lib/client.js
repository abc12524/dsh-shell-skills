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
 * Presentation lives in one self-injected stylesheet (`CARD_CSS`) built from the
 * host's design tokens, so the card follows the active theme instead of
 * hard-coding colours. Only theme tokens are used — no static palette — and
 * every interactive control keeps a visible focus ring.
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

    /**
     * Profile entry id of the manager's volatile state document.
     *
     * A separate settings namespace on purpose: card actions and Host state
     * mirrors write there, so they can never bump the revision of the form the
     * user is editing (which made "save" fail the revision fence).
     */
    const STATE_NS = 'dsh-shell-skills-state'

    /** Dictionary namespace owned by this card. */
    const LOCALE_NS = 'settings.shellSkills'

    const en = {
      title: 'Shell skills',
      description: 'Run shell-tool style Python skills and manage their installs.',
      enabled: 'Enable shell skills',
      enabledHint: 'When off, the manager stops syncing and the shell_skill tool reports an empty list.',
      hubSection: 'Remote repository',
      hubBase: 'Self-hosted base URL',
      hubBaseHint: 'Leave empty to read from public GitHub. An internal address such as http://192.168.30.181:3000 is read over the Gitea API instead.',
      hubRepo: 'Repository',
      hubRepoHint: 'owner/repo, for example abc12524/shell-skills.',
      hubBranch: 'Branch',
      hubBranchHint: 'Defaults to main.',
      installedSection: 'Installed skills',
      installedEmpty: 'No skills installed yet. Pull the remote list and download one.',
      remoteSection: 'Remote skills',
      remoteEmpty: 'Remote list not loaded yet. Refresh to see what the repository offers.',
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
      noDescription: 'No description',
      refreshHint: 'Pull the skill index from the repository above.',
    }

    const zh = {
      title: 'Shell skills',
      description: '运行 shell-tool 风格的 Python skill，并管理安装、启用与卸载。',
      enabled: '启用 shell skills',
      enabledHint: '关闭后不再同步管理状态，shell_skill 工具会返回空列表。',
      hubSection: '远程仓库',
      hubBase: '自建仓库基址',
      hubBaseHint: '留空即从 GitHub 公共仓库读取；填内网地址（如 http://192.168.30.181:3000）则改走 Gitea 接口。',
      hubRepo: '仓库',
      hubRepoHint: 'owner/repo，例如 abc12524/shell-skills。',
      hubBranch: '分支',
      hubBranchHint: '默认 main。',
      installedSection: '已安装 skill',
      installedEmpty: '还没有安装任何 skill。先拉取远程列表，再下载一个。',
      remoteSection: '远程 skill',
      remoteEmpty: '尚未加载远程列表。刷新一次即可看到仓库里有哪些 skill。',
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
      noDescription: '暂无说明',
      refreshHint: '从上面的仓库拉取 skill 索引。',
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

    /**
     * Which API dialect a base URL implies.
     *
     * Mirrors `kindOfHubBase()` in the Host half. It only labels the effective
     * source in the section header, so the card can never disagree with the
     * Host about where a request goes — the Host derives that itself.
     *
     * @param base - the base URL the user has staged.
     * @returns `gitea` or `github`.
     */
    function kindOfHubBase(base) {
      const trimmed = typeof base === 'string' ? base.trim() : ''
      if (trimmed.length === 0) return 'github'
      let host
      try {
        host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase()
      } catch {
        return 'gitea'
      }
      return host === 'github.com' || host === 'api.github.com' || host === 'raw.githubusercontent.com'
        ? 'github'
        : 'gitea'
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

    // -------------------------------------------------------------------------
    // Stylesheet
    // -------------------------------------------------------------------------

    /**
     * Card stylesheet.
     *
     * Every colour, radius and font resolves through a `--dsw-*` theme token so
     * light, dark and any future theme stay in step with the page. The local
     * `--sk-*` aliases only exist to keep the rules readable; the fallbacks are
     * the light-theme values, used by a host that has no theme layer at all.
     */
    const CARD_CSS = `
.sk {
  --sk-fg-1: var(--dsw-alias-label-primary, #0f1115);
  --sk-fg-2: var(--dsw-alias-label-secondary, #61666b);
  --sk-fg-3: var(--dsw-alias-label-tertiary, #81858c);
  --sk-hairline: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  --sk-stroke: var(--dsw-alias-settings-card-stroke, rgba(0, 0, 0, 0.1));
  --sk-surface: var(--dsw-alias-settings-card-fill, transparent);
  --sk-hover: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04));
  --sk-chip: var(--dsw-alias-bg-module-platform, rgba(0, 0, 0, 0.04));
  --sk-brand: var(--dsw-alias-brand-primary, #4d6bfe);
  --sk-success: var(--dsw-alias-state-success-primary, #0f9d58);
  --sk-danger: var(--dsw-alias-state-error-primary, #d9534f);
  --sk-warn: var(--dsw-alias-state-warn-primary, #b45309);
  --sk-radius-card: var(--dsw-radius-lg, 16px);
  --sk-radius-row: var(--dsw-radius-md, 12px);
  --sk-mono: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);

  display: flex;
  flex-direction: column;
  gap: 20px;
  container-type: inline-size;
}

/* ---- surfaces ------------------------------------------------------------ */

.sk-card {
  background: var(--sk-surface);
  border: 0.5px solid var(--sk-stroke);
  border-radius: var(--sk-radius-card);
  overflow: hidden;
}

/* ---- enable strip ------------------------------------------------------- */

.sk-hero {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
}

.sk-heroText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}

.sk-heroTitle {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--sk-fg-1);
}

.sk-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--sk-fg-2);
}

.sk-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: var(--sk-chip);
  color: var(--sk-fg-2);
  transition: background-color 160ms ease, color 160ms ease;
}

.sk-hero[data-on='true'] .sk-mark {
  background: color-mix(in srgb, var(--sk-brand) 14%, transparent);
  color: var(--sk-brand);
}

/* ---- section frame ------------------------------------------------------ */

.sk-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.sk-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  padding: 0 2px;
}

.sk-title {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--sk-fg-1);
}

.sk-count {
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--sk-fg-3);
}

/* Effective repository, kept beside the section title so it stays visible
   while the fields below are edited. */
.sk-source {
  max-width: 56%;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--sk-chip);
  font-family: var(--sk-mono);
  font-size: 11px;
  line-height: 16px;
  color: var(--sk-fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sk-spacer {
  flex: 1 1 auto;
}

/* ---- repository panel --------------------------------------------------- */

.sk-panelBody {
  padding: 0 14px 2px;
}

/* ---- skill lists -------------------------------------------------------- */

.sk-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 4px;
  list-style: none;
}

.sk-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--sk-radius-row);
}

.sk-row + .sk-row {
  border-top: 0.5px solid var(--sk-hairline);
}

@media (hover: hover) {
  .sk-row:hover {
    background: var(--sk-hover);
  }
}

.sk-rowMark {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--sk-chip);
  color: var(--sk-fg-2);
}

.sk-row[data-off='true'] .sk-rowMark {
  opacity: 0.55;
}

.sk-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.sk-nameLine {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.sk-name {
  font-family: var(--sk-mono);
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
  color: var(--sk-fg-1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sk-row[data-off='true'] .sk-name {
  color: var(--sk-fg-2);
}

.sk-version {
  flex: none;
  font-family: var(--sk-mono);
  font-size: 11px;
  line-height: 16px;
  color: var(--sk-fg-3);
  font-variant-numeric: tabular-nums;
}

.sk-desc {
  font-size: 12px;
  line-height: 18px;
  color: var(--sk-fg-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sk-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

/* Icon-only buttons keep a 28px target and only turn red on intent. */
.sk-iconBtn {
  width: 28px;
  min-width: 28px;
  padding: 0;
  color: var(--sk-fg-3);
}

.sk-iconBtn:hover:not(:disabled) {
  color: var(--sk-danger);
}

.sk-install {
  gap: 6px;
}

/* ---- empty state -------------------------------------------------------- */

.sk-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 16px;
  border: 0.5px dashed var(--sk-stroke);
  border-radius: var(--sk-radius-card);
  text-align: center;
}

.sk-emptyIcon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--sk-chip);
  color: var(--sk-fg-2);
}

.sk-emptyText {
  max-width: 320px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--sk-fg-2);
  text-wrap: balance;
}

/* ---- feedback ----------------------------------------------------------- */

.sk-foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sk-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--sk-radius-row);
  font-size: 12px;
  line-height: 18px;
  color: var(--sk-fg-2);
}

.sk-note > svg {
  flex: none;
  margin-top: 2px;
}

.sk-note[data-tone='ok'] {
  background: color-mix(in srgb, var(--sk-success) 9%, transparent);
}

.sk-note[data-tone='ok'] > svg {
  color: var(--sk-success);
}

.sk-note[data-tone='error'] {
  background: color-mix(in srgb, var(--sk-danger) 9%, transparent);
  color: var(--sk-fg-1);
}

.sk-note[data-tone='error'] > svg {
  color: var(--sk-danger);
}

.sk-noteText {
  min-width: 0;
  overflow-wrap: anywhere;
}

.sk-noteTime {
  margin-left: 6px;
  color: var(--sk-fg-3);
  font-variant-numeric: tabular-nums;
}

.sk-busy {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--sk-fg-2);
}

.sk-spinner {
  flex: none;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--sk-hairline);
  border-top-color: var(--sk-brand);
  border-radius: 50%;
  animation: sk-spin 700ms linear infinite;
}

@keyframes sk-spin {
  to { transform: rotate(360deg); }
}

/* ---- narrow panels ------------------------------------------------------ */

@container (max-width: 440px) {
  .sk-desc,
  .sk-source {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sk-spinner {
    animation-duration: 2400ms;
  }

  .sk-mark {
    transition: none;
  }
}
`

    /** Idempotently install the stylesheet; a no-op outside the browser. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const id = 'dsh-shell-skills/Card.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-shell-skills'
      tag.dataset.pluginCss = id
      tag.textContent = CARD_CSS
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // Card controller
    // -------------------------------------------------------------------------

    /** Card controller: owns the form, the state projection, and action writes. */
    class CardController {
      /**
       * @param scope - the bound settings scope for the editable form.
       * @param stateScope - the bound scope for the state document.
       */
      constructor(scope, stateScope) {
        this.scope = scope
        this.stateScope = stateScope
        this.busy = false
        this.writeFailed = false
        this.actionId = undefined
        this.busyTimer = undefined
        this.form = new P.SettingsFormModel(scope, [
          enabledField,
          textField('hubBase'),
          textField('hubRepo'),
          textField('hubBranch'),
        ])
        this.store = this.form.bind(() => this.projection())
        this.unsubscribe = scope.subscribe(() => { this.store.set(this.projection()) })
        this.stateUnsubscribe = stateScope.subscribe(() => { this.onStateChange() })
      }

      /** Clear the local in-flight marker and republish. */
      finishAction() {
        this.busy = false
        this.actionId = undefined
        clearTimeout(this.busyTimer)
        this.busyTimer = undefined
        this.store.set(this.projection())
      }

      /** Observe state writes: finish as soon as the action id is acknowledged. */
      onStateChange() {
        const value = this.stateScope.getSnapshot()?.value ?? {}
        if (this.actionId !== undefined && value.lastActionId === this.actionId) {
          this.finishAction()
          return
        }
        this.store.set(this.projection())
      }

      /** Build the snapshot the card reads. */
      projection() {
        const snapshot = this.scope.getSnapshot()
        const stateValue = this.stateScope.getSnapshot()?.value ?? {}
        const pending = parseJson(stateValue.pendingAction, null)
        const lastId = typeof stateValue.lastActionId === 'string' ? stateValue.lastActionId : ''
        const pendingAt = Number(pending?.at ?? 0)
        // An action without a timestamp (written by a build before the field
        // existed) is treated as expired. A persisted action must never pin
        // the card on "working" across a restart or a stopped manager.
        const pendingFresh = Number.isFinite(pendingAt) && pendingAt > 0 && Date.now() - pendingAt < 120000
        const actionPending = pending !== null
          && typeof pending === 'object'
          && typeof pending.id === 'string'
          && pending.id !== lastId
          && pendingFresh
        return {
          ...this.form.shell(),
          enabled: this.form.field('enabled').text !== 'off',
          hubBase: this.form.field('hubBase'),
          hubRepo: this.form.field('hubRepo'),
          hubBranch: this.form.field('hubBranch'),
          installed: parseJson(stateValue.installedJson, []),
          remote: parseJson(stateValue.remoteJson, []),
          status: parseJson(stateValue.statusJson, null),
          busy: this.busy || actionPending,
          writeFailed: this.writeFailed,
        }
      }

      /**
       * Ask the Host to perform one manager action.
       *
       * The command goes to the state document, never to the form document:
       * writing it here cannot invalidate an unsaved edit.
       *
       * @param type - action verb the Host understands.
       * @param name - target skill, when the verb needs one.
       */
      async runAction(type, name) {
        const revision = this.stateScope.getSnapshot()?.revision
        const action = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type,
          at: Date.now(),
          ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
        }
        this.actionId = action.id
        this.busy = true
        this.writeFailed = false
        clearTimeout(this.busyTimer)
        // The Host acknowledges by writing `lastActionId`; the subscription
        // clears `busy` then. This deadline only releases a card whose Host
        // never answers (plugin unloaded, a wedged request, a stale profile).
        this.busyTimer = setTimeout(() => { this.finishAction() }, 30000)
        this.busyTimer.unref?.()
        this.store.set(this.projection())
        let accepted = false
        try {
          accepted = await this.stateScope.mutate(
            [{ op: 'set', path: ['pendingAction'], value: JSON.stringify(action) }],
            revision,
          )
        } catch {
          accepted = false
        }
        if (!accepted) {
          this.writeFailed = true
          this.finishAction()
          return
        }
        this.store.set(this.projection())
      }

      /** The face the plugin's slot registration injects. */
      inject() {
        return {
          hooks: { shellSkillsCard: this.store },
          ...this.form.actions(),
          runAction: (type, name) => this.runAction(type, name),
        }
      }

      /** Release subscriptions and the in-flight deadline. */
      dispose() {
        clearTimeout(this.busyTimer)
        if (typeof this.unsubscribe === 'function') this.unsubscribe()
        if (typeof this.stateUnsubscribe === 'function') this.stateUnsubscribe()
        this.form.dispose()
      }
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    /**
     * Render one primitive icon by export name.
     *
     * The icon set is part of the primitives module, but a host that predates a
     * glyph would otherwise crash the whole card: a missing component renders
     * nothing instead.
     *
     * @param exportName - primitives export, e.g. `IconSkillOutlineRegular`.
     * @param size - pixel box.
     * @returns the icon, or null.
     */
    function icon(exportName, size) {
      const Component = P[exportName]
      return typeof Component === 'function' ? jsx(Component, { size }) : null
    }

    /**
     * Wall-clock label for a status timestamp.
     * @param at - epoch milliseconds.
     * @returns `HH:MM`, or an empty string when the stamp is unusable.
     */
    function clockOf(at) {
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
      try {
        return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** Section heading with an optional count and trailing control. */
    function section(t, { title, count, action, children }) {
      return jsxs('section', {
        className: 'sk-section',
        children: [
          jsxs('div', {
            className: 'sk-head',
            children: [
              jsx('h4', { className: 'sk-title', children: t(title) }),
              typeof count === 'number' ? jsx('span', { className: 'sk-count', children: String(count) }) : null,
              jsx('span', { className: 'sk-spacer', 'aria-hidden': 'true' }),
              action ?? null,
            ],
          }),
          children,
        ],
      })
    }

    /** Placeholder shown instead of a list that has no rows yet. */
    function emptyState(t, { text, iconName }) {
      return jsxs('div', {
        className: 'sk-empty',
        children: [
          jsx('span', { className: 'sk-emptyIcon', 'aria-hidden': 'true', children: icon(iconName, 16) }),
          jsx('p', { className: 'sk-emptyText', children: t(text) }),
        ],
      })
    }

    /**
     * One skill row.
     *
     * @param spec - name, description, leading/extra tags, and trailing actions.
     * @returns the `<li>`.
     */
    function skillRow({ name, description, version, off, tags, actions }) {
      return jsxs('li', {
        key: name,
        className: 'sk-row',
        'data-off': off ? 'true' : undefined,
        children: [
          jsx('span', {
            className: 'sk-rowMark',
            'aria-hidden': 'true',
            children: icon('IconSkillOutlineRegular', 14),
          }),
          jsxs('div', {
            className: 'sk-body',
            children: [
              jsxs('div', {
                className: 'sk-nameLine',
                children: [
                  jsx('span', { className: 'sk-name', title: name, children: name }),
                  tags ?? null,
                  typeof version === 'string' && version.length > 0
                    ? jsx('span', { className: 'sk-version', children: version })
                    : null,
                ],
              }),
              description
                ? jsx('span', { className: 'sk-desc', title: description, children: description })
                : null,
            ],
          }),
          jsx('div', { className: 'sk-actions', children: actions }),
        ],
      })
    }

    /** One feedback note with an icon that carries the tone. */
    function note(t, { tone, text, at }) {
      const stamp = clockOf(at)
      return jsxs('div', {
        className: 'sk-note',
        'data-tone': tone,
        role: 'status',
        children: [
          icon(tone === 'ok' ? 'IconCheckCircleFillMedium' : 'IconWarningOutlineRegular', 14),
          jsxs('span', {
            className: 'sk-noteText',
            children: [
              text,
              stamp ? jsx('span', { className: 'sk-noteTime', children: stamp }) : null,
            ],
          }),
        ],
      })
    }

    /** Render the card. */
    function ShellSkillsCard(props) {
      const { t } = props
      const state = props.useShellSkillsCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')

      const disabled = !state.writable || state.busy
      const installed = Array.isArray(state.installed) ? state.installed : []
      const remote = Array.isArray(state.remote) ? state.remote : []
      const repository = state.hubRepo?.text || t('hubRepoHint')
      const branch = state.hubBranch?.text || 'main'
      // The base URL is the switch: empty means public GitHub, anything else is
      // read over the Gitea API. Showing the resolved dialect beside the title
      // means the user never has to guess which endpoint a save will hit.
      const kind = kindOfHubBase(state.hubBase?.text)
      const source = `${kind === 'gitea' ? 'Gitea' : 'GitHub'} · ${repository}@${branch}`

      const installedRows = installed.map((skill) => {
        const on = skill.status === 'enable'
        const verb = on ? t('disable') : t('enable')
        return skillRow({
          name: skill.name,
          description: skill.description || t('noDescription'),
          off: !on,
          tags: jsx(P.Tag, {
            tone: on ? 'success' : 'quiet',
            children: on ? t('statusEnable') : t('statusDisable'),
          }),
          actions: [
            jsx(P.Switch, {
              checked: on,
              disabled,
              label: `${skill.name} ${verb}`,
              title: verb,
              onChange: (next) => { props.runAction(next ? 'enable' : 'disable', skill.name) },
            }),
            jsx(P.Button, {
              className: 'sk-iconBtn',
              size: 'sm',
              variant: 'ghost',
              disabled,
              icon: icon('IconTrashOutlineRegular', 14),
              'aria-label': `${t('remove')} ${skill.name}`,
              title: `${t('remove')} ${skill.name}`,
              onClick: () => { props.runAction('remove', skill.name) },
            }),
          ],
        })
      })

      const remoteRows = remote.map((skill) => skillRow({
        name: skill.name,
        description: skill.description || t('noDescription'),
        version: skill.version,
        tags: null,
        actions: skill.installed
          ? jsx(P.Tag, { tone: 'neutral', children: t('installed') })
          : jsx(P.Button, {
            className: 'sk-install',
            size: 'sm',
            variant: 'outline',
            disabled,
            icon: icon('IconDownloadOutlineRegular', 14),
            'aria-label': `${t('install')} ${skill.name}`,
            title: `${t('install')} ${skill.name}`,
            onClick: () => { props.runAction('install', skill.name) },
            children: t('install'),
          }),
      }))

      const actionKey = state.status?.action
      const actionLabel = typeof actionKey === 'string' && actionKey.length > 0
        ? t(actionKey)
        : t('lastResult')
      const statusText = state.status
        ? (state.status.ok
            ? `${t('lastResult')} · ${actionLabel}`
            : `${t('lastResult')} · ${actionLabel} — ${state.status.message ?? ''}`)
        : ''

      const hasFeedback = state.busy || state.writeFailed || state.status !== null

      return jsx(P.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: jsxs('div', {
          className: 'sk',
          children: [
            jsxs('div', {
              className: 'sk-card sk-hero',
              'data-on': state.enabled ? 'true' : 'false',
              children: [
                jsx('span', { className: 'sk-mark', 'aria-hidden': 'true', children: icon('IconSkillOutlineRegular', 16) }),
                jsxs('div', {
                  className: 'sk-heroText',
                  children: [
                    jsx('span', { className: 'sk-heroTitle', children: t('enabled') }),
                    jsx('span', { className: 'sk-hint', children: t('enabledHint') }),
                  ],
                }),
                jsx(P.Switch, {
                  checked: state.enabled,
                  disabled: !state.writable,
                  label: t('enabled'),
                  title: t('enabledHint'),
                  onChange: (next) => { props.edit('enabled', next ? 'on' : 'off') },
                }),
              ],
            }),
            section(t, {
              title: 'hubSection',
              action: jsx('span', { className: 'sk-source', title: source, children: source }),
              children: jsxs('div', {
                className: 'sk-card',
                children: [
                  jsxs('div', {
                    className: 'sk-panelBody',
                    children: [
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
                    ],
                  }),
                ],
              }),
            }),
            section(t, {
              title: 'installedSection',
              count: installed.length,
              children: installed.length === 0
                ? emptyState(t, { text: 'installedEmpty', iconName: 'IconSkillOutlineRegular' })
                : jsx('ul', { className: 'sk-card sk-list', children: installedRows }),
            }),
            section(t, {
              title: 'remoteSection',
              count: remote.length,
              action: jsx(P.Button, {
                size: 'sm',
                variant: 'ghost',
                disabled,
                icon: icon('IconRefreshOutlineRegular', 14),
                title: t('refreshHint'),
                onClick: () => { props.runAction('refreshRemote') },
                children: t('refreshRemote'),
              }),
              children: remote.length === 0
                ? emptyState(t, { text: 'remoteEmpty', iconName: 'IconGlobeOutlineRegular' })
                : jsx('ul', { className: 'sk-card sk-list', children: remoteRows }),
            }),
            hasFeedback
              ? jsxs('div', {
                className: 'sk-foot',
                children: [
                  state.busy
                    ? jsxs('div', {
                      className: 'sk-busy',
                      role: 'status',
                      children: [
                        jsx('span', { className: 'sk-spinner', 'aria-hidden': 'true' }),
                        jsx('span', { children: t('working') }),
                      ],
                    })
                    : null,
                  state.writeFailed ? note(t, { tone: 'error', text: t('writeFailed') }) : null,
                  state.status
                    ? note(t, {
                      tone: state.status.ok ? 'ok' : 'error',
                      text: statusText,
                      at: state.status.at,
                    })
                    : null,
                ],
              })
              : null,
          ],
        }),
      })
    }

    /** Required client services. */
    const inject = ['slots', 'locale', 'configForms']

    /** Mount the manager card while the Host serves this namespace. */
    function apply(ctx) {
      ensureStyles()
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { zh, en }),
        'dsh-shell-skills: dictionaries',
      )
      const scope = ctx.configForms.get(NS)
      const stateScope = ctx.configForms.get(STATE_NS)
      const card = new CardController(scope, stateScope)
      ctx.effect(() => () => { card.dispose() }, 'dsh-shell-skills: form subscription')
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS, STATE_NS], () =>
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
