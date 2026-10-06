/**
 * Browser half of dsh-lh-workspace-roots: a "Roots" page tab in the right
 * Sidebar that lists the session cwd and every extra root as one lazy tree.
 *
 * Hand-written in the `__ModuleLoader__` factory form that tsdown emits for
 * upstream client plugins, so the repo keeps no build step. Its `require`
 * reaches only the client baseline (React, ui-primitives).
 *
 * - Roots: the cwd, then the absolute directory candidates of
 *   `remote.fileReferences.list(sessionId, '')` (MultiRootFileReferenceService
 *   offers the extra roots there).
 * - Listings: `remote.workspaceFiles.list(sessionId, absolutePath)`; the
 *   `/workspace-files` plugin lets it list inside the extra roots.
 * - Files open through `tab.actions.openResource` with the same
 *   `dsh-resource://file/session/...` address the Files tab builds.
 *
 * Expansion is component state and resets when the tab body remounts; the
 * reload button re-lists every open directory. No watches.
 */
window.__ModuleLoader__.load({
  id: 'dsh-lh-workspace-roots',
  factory: (require) => {
    const { createElement: h, Fragment, useEffect, useState } = require('react')
    const {
      FileTypeIcon, GuideArtworkFiles, IconFolderCloseRegular, IconFolderOpenRegular,
      IconRefreshOutlineRegular, classifyFileType,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ID = 'dsh-lh-workspace-roots'
    const KIND = 'workspace-roots'
    const NS = 'lhWorkspaceRoots'

    const en = {
      'type.label': 'Roots',
      'guide.title': 'Workspace roots',
      'guide.description': 'Browse the session folder and its extra writable roots',
      'root.primary': 'session folder',
      loading: 'Reading…',
      empty: 'Empty directory',
      truncated: 'Too many entries, showing only some of them.',
      noWorkspace: 'This session has no workspace directory.',
      reload: 'Reload',
      'error.notFound': 'That directory is gone. It may have been moved or deleted.',
      'error.outsideWorkspace': 'That directory is outside every root of this session.',
      'error.notDirectory': 'That is not a directory.',
      'error.unavailable': 'Read failed: {message}',
    }
    const zh = {
      'type.label': '根目录',
      'guide.title': '工作区根目录',
      'guide.description': '浏览会话目录及其额外的可写根目录',
      'root.primary': '会话目录',
      loading: '正在读取…',
      empty: '空目录',
      truncated: '条目太多，只显示了一部分。',
      noWorkspace: '这个会话没有工作区目录。',
      reload: '重新读取',
      'error.notFound': '这个目录不在了。可能已被移动或删除。',
      'error.outsideWorkspace': '这个目录不在会话的任何根目录内。',
      'error.notDirectory': '这不是一个目录。',
      'error.unavailable': '读取失败：{message}',
    }

    const CSS = `
.lhroots-root { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5; }
.lhroots-header { display: flex; flex: 0 0 auto; gap: 4px; align-items: center; justify-content: flex-end; box-sizing: border-box; height: 38px; padding: 0 6px 0 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.lhroots-body { flex: 1 1 auto; min-height: 0; margin-right: 2px; padding: 8px 0 8px 8px; overflow: auto; scrollbar-gutter: stable; }
.lhroots-level { margin: 0; padding: 0; list-style: none; }
.lhroots-level .lhroots-level { padding-left: 18px; }
.lhroots-row { display: flex; gap: 6px; align-items: center; width: 100%; min-width: 0; padding: 5px 10px; color: inherit; font: inherit; text-align: left; background: transparent; border: 0; border-radius: var(--dsw-radius-md); cursor: pointer; }
.lhroots-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lhroots-icon { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.lhroots-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.lhroots-rootname { font-weight: 600; }
.lhroots-path { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-tertiary); white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }
.lhroots-other { color: var(--dsw-alias-label-tertiary); cursor: default; }
.lhroots-other:hover { background: transparent; }
.lhroots-note { margin: 0; padding: 3px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.lhroots-tool { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 6px; color: var(--dsw-alias-label-secondary); background: transparent; border: none; border-radius: var(--dsw-radius-sm); cursor: pointer; }
.lhroots-tool svg { width: 15px; height: 15px; }
.lhroots-tool:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
`

    const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

    function orderEntries(entries) {
      return [...entries].sort((left, right) => {
        const group = Number(right.type === 'directory') - Number(left.type === 'directory')
        return group !== 0 ? group : byName.compare(left.name, right.name)
      })
    }

    function trimSlash(path) {
      return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
    }

    function childPath(parent, name) {
      return `${trimSlash(parent)}/${name}`
    }

    function basename(path) {
      const trimmed = trimSlash(path)
      return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
    }

    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    // Mirrors fileAddressFor in @deepseek-ai/dsh-util-workspace-path.
    function fileAddress(sessionId, cwd, path) {
      const normalized = path.replace(/\\/g, '/')
      const root = cwd === undefined ? '' : trimSlash(cwd.replace(/\\/g, '/'))
      const relative = root !== '' && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${relative.split('/').map(encodeSegment).join('/')}`
    }

    function failureLine(t, failure) {
      switch (failure.code) {
        case 'workspace-file/not-found': return t('error.notFound')
        case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
        case 'workspace-file/not-directory': return t('error.notDirectory')
        default: return t('error.unavailable', { message: failure.message })
      }
    }

    function Note({ children }) {
      return h('li', { className: 'lhroots-note' }, children)
    }

    /** One directory's rows, listed while mounted and again on every reload. */
    function Level({ path, tree }) {
      const [state, setState] = useState({ kind: 'loading' })
      useEffect(() => {
        const controller = new AbortController()
        tree.listDir(path, controller.signal).then((result) => {
          if (controller.signal.aborted) return
          setState(result.ok
            ? { kind: 'ready', entries: orderEntries(result.value.entries), truncated: result.value.truncated }
            : { kind: 'failed', failure: result.error })
        })
        return () => { controller.abort() }
      }, [path, tree.generation])
      const { t } = tree
      if (state.kind === 'loading') return h(Note, null, t('loading'))
      if (state.kind === 'failed') return h(Note, null, failureLine(t, state.failure))
      return h(Fragment, null,
        state.entries.length === 0 && h(Note, null, t('empty')),
        state.entries.map((entry) => h(Entry, { key: entry.name, parent: path, entry, tree })),
        state.truncated && h(Note, null, t('truncated')))
    }

    function Directory({ path, label, detail, tree }) {
      const [expanded, setExpanded] = useState(false)
      return h('li', { 'data-roots-entry': 'directory', 'data-roots-path': path },
        h('button', { type: 'button', className: 'lhroots-row', title: path, 'aria-expanded': expanded, onClick: () => { setExpanded(!expanded) } },
          h(expanded ? IconFolderOpenRegular : IconFolderCloseRegular, { className: 'lhroots-icon' }),
          label,
          detail),
        expanded && h('ul', { className: 'lhroots-level' }, h(Level, { path, tree })))
    }

    function Entry({ parent, entry, tree }) {
      const path = childPath(parent, entry.name)
      const name = h('span', { className: 'lhroots-name' }, entry.name)
      if (entry.type === 'directory') return h(Directory, { path, label: name, tree })
      if (entry.type === 'file') {
        return h('li', { 'data-roots-entry': 'file', 'data-roots-path': path },
          h('button', { type: 'button', className: 'lhroots-row', title: path, onClick: () => { tree.open(path) } },
            h(FileTypeIcon, { kind: classifyFileType(entry.name), size: 16, className: 'lhroots-icon' }),
            name))
      }
      return h('li', { 'data-roots-entry': 'other' }, h('span', { className: 'lhroots-row lhroots-other', 'aria-disabled': 'true' }, name))
    }

    function RootsBody({ useTabInfo, sessionId, useSessions, t, listRoots, listDir }) {
      const { tab } = useTabInfo()
      const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd)
      const [generation, setGeneration] = useState(0)
      const [extras, setExtras] = useState([])
      // listRoots is left out: only a reload, a new cwd or another session re-lists the roots.
      useEffect(() => {
        const controller = new AbortController()
        listRoots(controller.signal).then((roots) => { if (!controller.signal.aborted) setExtras(roots) })
        return () => { controller.abort() }
      }, [sessionId, generation, cwd])
      if (cwd === undefined) return h('div', { className: 'lhroots-root' }, h('p', { className: 'lhroots-note' }, t('noWorkspace')))
      const tree = {
        t,
        generation,
        listDir,
        open: (path) => { tab.actions.openResource(fileAddress(sessionId, cwd, path)) },
      }
      const primary = trimSlash(cwd)
      const roots = [primary, ...extras.filter((root) => root !== primary)]
      return h('div', { className: 'lhroots-root', 'data-roots-state': 'tree' },
        h('div', { className: 'lhroots-header' },
          h('button', { type: 'button', className: 'lhroots-tool', 'aria-label': t('reload'), title: t('reload'), onClick: () => { setGeneration(generation + 1) } },
            h(IconRefreshOutlineRegular))),
        h('div', { className: 'lhroots-body' },
          h('ul', { className: 'lhroots-level' }, roots.map((root) => h(Directory, {
            key: root,
            path: root,
            tree,
            label: h('span', { className: 'lhroots-name lhroots-rootname' }, basename(root)),
            detail: h('span', { className: 'lhroots-path' }, root === primary ? t('root.primary') : root),
          })))))
    }

    function RootsTitle({ useTabInfo }) {
      const { tab } = useTabInfo()
      return h(Fragment, null, h(FileTypeIcon, { kind: 'folder', size: 16 }), tab.title)
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'remote.fileReferences']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.dshPlugin = ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'lh-workspace-roots: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'lh-workspace-roots: dictionaries')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('type.label'),
        guide: [{
          id: 'roots',
          order: 11,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: GuideArtworkFiles,
        }],
      }), 'lh-workspace-roots: tab type')
      const face = (sessionId) => ({
        listRoots: (signal) => ctx.remote.fileReferences.list(sessionId, '', signal).then((result) => (result.ok
          ? result.value.filter((candidate) => candidate.kind === 'directory' && candidate.path.startsWith('/')).map((candidate) => trimSlash(candidate.path))
          : [])),
        listDir: (path, signal) => ctx.remote.workspaceFiles.list(sessionId, path, signal),
      })
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: ID, locale: NS, inject: face },
        RootsBody,
      )), 'lh-workspace-roots: tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: ID },
        RootsTitle,
      )), 'lh-workspace-roots: tab title')
    }

    return { apply, inject }
  },
})
