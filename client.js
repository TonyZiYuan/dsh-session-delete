/**
 * dsh-session-delete — browser half.
 *
 * Contributes two things to the web shell:
 *
 *   1. a `sidebar.workspaces.session.menu.item` row, "Delete Session", which
 *      opens the confirmation dialog. The row sits after the shipped archive
 *      row by its own `order`, exactly as the shipped actions do.
 *   2. a `shell.overlay` entry holding the confirmation dialog: what the
 *      session is, how big its log is, how many descendants go with it, a link
 *      to export it first, and an acknowledgement that must be checked before
 *      the destructive action is available.
 *
 * Data goes over the plugin's own same-origin `/api/session-delete/*` routes
 * rather than a typed Remote binding, because the Host half owns those routes
 * and there is nothing to bind: `SessionPersistence` has no delete method to
 * expose.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')
    const {
      Button, Modal, MenuItemButton, Checkbox,
      IconTrashOutlineRegular, IconWarningOutlineRegular, IconDownloadOutlineRegular,
    } = P

    const NS = 'session-delete'
    const inject = ['slots', 'locale']

    const API = '/api/session-delete'

    // ─── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'menu.delete': '删除会话',
        'dialog.title': '删除会话',
        'dialog.desc': '此操作不可撤销。会话的完整日志将从磁盘上永久移除。',
        'dialog.session': '会话',
        'dialog.created': '创建时间',
        'dialog.size': '日志大小',
        'dialog.descendants': '包含子会话',
        'dialog.cascade': '将同时删除 {n} 个子会话及其后代。子会话在侧边栏不可见，无法通过其它方式单独删除。',
        'dialog.liveNote': '该会话仍在运行。删除前会先停止它的工作，然后移除日志。',
        'dialog.loading': '正在读取会话信息…',
        'dialog.failed': '无法读取会话信息：{reason}',
        'dialog.exportFirst': '建议先导出备份',
        'dialog.exportLink': '下载此会话的 ZIP 归档',
        'dialog.acknowledge': '我已导出备份，或确认不再需要此会话',
        'dialog.cancel': '取消',
        'dialog.confirm': '永久删除',
        'dialog.pending': '正在删除…',
        'dialog.error': '删除失败：{reason}',
        'dialog.done': '会话已删除',
        'dialog.registryWarn': '注意：工作区注册表的清理未完成，重启 DSH 后归档列表中的残留行会消失。',
        'size.bytes': '{n} B',
        'size.kb': '{n} KB',
        'size.mb': '{n} MB',
      },
      en: {
        'menu.delete': 'Delete Session',
        'dialog.title': 'Delete Session',
        'dialog.desc': 'This cannot be undone. The complete session log is removed from disk permanently.',
        'dialog.session': 'Session',
        'dialog.created': 'Created',
        'dialog.size': 'Log size',
        'dialog.descendants': 'Includes subagents',
        'dialog.cascade': 'This also deletes {n} subagent session(s) and their descendants. Subagents are hidden from the sidebar and cannot be deleted separately.',
        'dialog.liveNote': 'This session is still running. Its work is stopped first, then the log is removed.',
        'dialog.loading': 'Reading session…',
        'dialog.failed': 'Could not read the session: {reason}',
        'dialog.exportFirst': 'Export a backup first',
        'dialog.exportLink': 'Download this session as a ZIP archive',
        'dialog.acknowledge': 'I have exported a backup, or I confirm I no longer need this session',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Delete permanently',
        'dialog.pending': 'Deleting…',
        'dialog.error': 'Delete failed: {reason}',
        'dialog.done': 'Session deleted',
        'dialog.registryWarn': 'Note: the workspace registry was not fully cleaned; restart DSH to drop the leftover archived row.',
        'size.bytes': '{n} B',
        'size.kb': '{n} KB',
        'size.mb': '{n} MB',
      },
    }

    /** Human-readable byte count. */
    function sizeText(bytes, t) {
      const n = Number(bytes) || 0
      if (n < 1024) return t('size.bytes', { n: String(n) })
      if (n < 1024 * 1024) return t('size.kb', { n: (n / 1024).toFixed(1) })
      return t('size.mb', { n: (n / (1024 * 1024)).toFixed(1) })
    }

    /** Absolute timestamp as a short local date-time. */
    function timeText(ms) {
      const value = Number(ms) || 0
      if (value <= 0) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return '—'
      }
    }

    /**
     * One delete request in flight. Created when the menu row is selected and
     * settled by the dialog, so its in-flight and error state die with it.
     */
    let requestSeq = 0
    const makeRequest = (sessionId, displayTitle) => ({ key: `d${++requestSeq}`, sessionId, displayTitle })

    /** GET the deletable-session list; resolves the entry for one id. */
    async function fetchSession(sessionId) {
      const response = await fetch(`${API}/sessions`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const list = Array.isArray(payload?.sessions) ? payload.sessions : []
      return list.find((entry) => entry?.sessionId === sessionId) ?? null
    }

    /** POST the delete. */
    async function postDelete(sessionId) {
      const response = await fetch(`${API}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let payload = null
      try { payload = await response.json() } catch { /* non-JSON error body */ }
      if (!response.ok || payload?.ok !== true) {
        // Carry the Host's stable code on the error so the dialog can name it.
        const failure = new Error(String(payload?.error ?? `HTTP ${response.status}`))
        failure.code = typeof payload?.code === 'string' ? payload.code : ''
        throw failure
      }
      return payload
    }

    // ─── registration ──────────────────────────────────────────────────────────

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-session-delete: dictionaries')

      // A reactive store, not a plain object. `apply` is a plugin body, not a
      // component, so mutating a bare holder here notifies nobody: the dialog
      // would only ever appear on some unrelated re-render (switching session),
      // and its buttons would look dead. The store is handed to the slot
      // system through the inject face's `hooks` compartment, which is what
      // synthesizes `useDeleteRequest` on the component and wires it to React.
      const deleteRequest = createSnapshotStore(null)

      const requestDelete = (sessionId, displayTitle) => {
        deleteRequest.set(makeRequest(sessionId, displayTitle))
      }

      const settle = () => deleteRequest.set(null)

      // No client-side list refresh exists (SessionsService exposes none), and
      // none is needed: the Host publishes `api-session/removed` after a
      // successful delete, the session controller records a `remove` mutation,
      // and `projectList()` drops the row. Anything else here would be dead
      // code pretending to help.

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dsh-session-delete',
        order: 500,
        locale: NS,
        inject: () => ({ requestDelete }),
      }, props => h(DeleteSessionMenuItem, { ...props, t })))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-session-delete.confirm',
        locale: NS,
        inject: () => ({ hooks: { deleteRequest }, settle }),
      }, props => h(DeleteSessionDialog, { ...props, t })))
    }

    /**
     * Menu row (order 500): ask for the delete dialog. The row carries no
     * disabled state — whether a session can be deleted is the Host's answer,
     * which the dialog surfaces.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(MenuItemButton, {
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        danger: true,
        separatorBefore: true,
        onSelect: () => {
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle)
        },
      }, t('menu.delete'))
    }

    /**
     * Risk-gated confirmation composed from `Modal`.
     *
     * NOT `RiskConfirmation`: that primitive's signature takes no `children`
     * — its body is hardcoded to the warning row plus the acknowledgement
     * checkbox — so anything a caller passes as children is silently dropped.
     * Its gate semantics (confirm disabled until acknowledged) are reproduced
     * here on `Modal`, which does render children.
     */
    function RiskDialog({ open, title, description, acknowledgeLabel, cancelLabel, closeLabel, confirmLabel, acknowledged, disabled = false, onAcknowledgedChange, onCancel, onConfirm, children }) {
      return h(Modal, {
        open,
        onClose: onCancel,
        title,
        closeLabel,
        footer: h(Fragment, null, [
          h(Button, { key: 'cancel', variant: 'outline', onClick: onCancel }, cancelLabel),
          h(Button, {
            key: 'confirm',
            variant: 'primary',
            disabled: disabled || !acknowledged,
            onClick: onConfirm,
          }, confirmLabel),
        ]),
      }, [
        h('div', {
          key: 'warn',
          className: 'dsh-session-delete-warning',
          style: { display: 'flex', gap: 8, alignItems: 'flex-start', margin: '4px 0 12px' },
        }, [
          h(IconWarningOutlineRegular, { key: 'i', size: 18 }),
          h('p', { key: 't', style: { margin: 0 } }, description),
        ]),
        h(Fragment, { key: 'body' }, children),
        h('label', {
          key: 'ack',
          className: 'dsh-session-delete-ack',
          style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, cursor: 'pointer' },
        }, [
          h('input', {
            key: 'c',
            type: 'checkbox',
            checked: acknowledged,
            disabled,
            'data-modal-autofocus': true,
            onChange: (event) => { onAcknowledgedChange(event.currentTarget.checked) },
          }),
          h('span', { key: 'l' }, acknowledgeLabel),
        ]),
      ])
    }

    /**
     * The confirmation dialog. Nothing while no request is pending, otherwise
     * one dialog per request keyed by the session, so a new request starts a
     * fresh acknowledgement and a fresh in-flight state.
     */
    function DeleteSessionDialog({ useDeleteRequest, settle, t }) {
      const request = useDeleteRequest((pending) => pending)
      if (request === null || request === undefined) return null
      return h(DeleteForm, { key: request.key, request, settle, t })
    }

    /** One request's dialog body. */
    function DeleteForm({ request, settle, t }) {
      const [entry, setEntry] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [acknowledged, setAcknowledged] = useState(false)
      const [deleting, setDeleting] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)

      useEffect(() => {
        let live = true
        fetchSession(request.sessionId)
          .then((found) => { if (live) setEntry(found) })
          .catch((reason) => { if (live) setLoadError(String(reason?.message ?? reason)) })
        return () => { live = false }
      }, [request.sessionId])

      const close = () => {
        if (deleting) return
        settle()
      }

      const confirm = () => {
        if (deleting || !acknowledged) return
        setDeleting(true)
        setError(null)
        setNotice(null)
        postDelete(request.sessionId)
          .then((result) => {
            setDeleting(false)
            if (result.registryCleaned === false) {
              // Say so before closing: the log is already gone, and the user
              // should know the archived row may linger until the next boot.
              setNotice(t('dialog.registryWarn'))
              setTimeout(settle, 6000)
              return
            }
            settle()
          })
          .catch((reason) => {
            setDeleting(false)
            // The Host answers with a stable code plus a human message. Show
            // both: the message is what the user acts on, the code is what a
            // bug report can be searched by.
            const code = String(reason?.code ?? '').trim()
            const message = String(reason?.message ?? reason)
            setError(code === '' ? t('dialog.error', { reason: message }) : `${t('dialog.error', { reason: message })} [${code}]`)
          })
      }

      const title = entry?.title || request.displayTitle || request.sessionId
      const live = entry?.live === true
      const descendants = Number(entry?.descendantCount) || 0
      const loading = entry === null && loadError === null

      // Composed from Modal, NOT RiskConfirmation: that primitive takes no
      // `children` (its body is hardcoded to warning + checkbox), so every
      // fact row, the export link, and the loading/error lines passed below
      // would be silently dropped.
      return h(RiskDialog, {
        open: true,
        title: t('dialog.title'),
        description: t('dialog.desc'),
        acknowledgeLabel: t('dialog.acknowledge'),
        cancelLabel: t('dialog.cancel'),
        closeLabel: t('dialog.cancel'),
        confirmLabel: t('dialog.confirm'),
        acknowledged,
        // Live is NOT a reason to disable: the Host stops the session's work
        // before removing anything. Disabling here is what made deletion look
        // like it only worked sometimes — the button was greyed out for exactly
        // the sessions the user still had open.
        disabled: deleting || loading,
        onAcknowledgedChange: setAcknowledged,
        onCancel: close,
        onConfirm: confirm,
      }, [
        loading && h('div', { key: 'loading', className: 'dsh-session-delete-loading', role: 'status' }, t('dialog.loading')),
        loadError !== null && h('div', { key: 'load-error', className: 'dsh-session-delete-error', role: 'alert' },
          t('dialog.failed', { reason: loadError })),

        entry !== null && h('dl', { key: 'facts', className: 'dsh-session-delete-facts' }, [
          h('div', { key: 'session', className: 'dsh-session-delete-fact' }, [
            h('dt', { key: 'k' }, t('dialog.session')),
            h('dd', { key: 'v' }, title),
          ]),
          h('div', { key: 'created', className: 'dsh-session-delete-fact' }, [
            h('dt', { key: 'k' }, t('dialog.created')),
            h('dd', { key: 'v' }, timeText(entry.createdAt)),
          ]),
          h('div', { key: 'size', className: 'dsh-session-delete-fact' }, [
            h('dt', { key: 'k' }, t('dialog.size')),
            h('dd', { key: 'v' }, sizeText(entry.sizeBytes, t)),
          ]),
          descendants > 0 && h('div', { key: 'descendants', className: 'dsh-session-delete-fact' }, [
            h('dt', { key: 'k' }, t('dialog.descendants')),
            h('dd', { key: 'v' }, String(descendants)),
          ]),
        ]),

        live && h('div', { key: 'live', className: 'dsh-session-delete-note', role: 'note' }, t('dialog.liveNote')),

        // Say what else goes. Silently removing child logs — or leaving them as
        // unreachable orphans — would both be surprises; neither is acceptable
        // for an irreversible action.
        descendants > 0 && h('div', { key: 'cascade', className: 'dsh-session-delete-note', role: 'note' },
          t('dialog.cascade', { n: String(descendants) })),

        h('div', { key: 'export', className: 'dsh-session-delete-export' }, [
          h('div', { key: 'hint', className: 'dsh-session-delete-export-hint' }, [
            h(IconWarningOutlineRegular, { key: 'icon', size: 14 }),
            h('span', { key: 'text' }, t('dialog.exportFirst')),
          ]),
          h('a', {
            key: 'link',
            className: 'dsh-session-delete-export-link',
            href: `/api/session.export?sessionId=${encodeURIComponent(request.sessionId)}`,
            target: '_blank',
            rel: 'noreferrer',
          }, [
            h(IconDownloadOutlineRegular, { key: 'icon', size: 14 }),
            h('span', { key: 'text' }, t('dialog.exportLink')),
          ]),
        ]),

        deleting && h('div', { key: 'pending', className: 'dsh-session-delete-pending', role: 'status' }, t('dialog.pending')),
        error !== null && h('div', { key: 'error', className: 'dsh-session-delete-error', role: 'alert' }, error),
      ])
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-session-delete'
    exports.__test = { DICT, sizeText, timeText }
    return module.exports
  },
})
