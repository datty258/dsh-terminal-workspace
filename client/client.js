/**
 * Browser half of `dsh-terminal-workspace`.
 *
 * A sidebar row plus a main panel shaped like an iTerm2 window: one tab strip,
 * and each tab split into panes. Every pane is an xterm.js screen bound to a
 * shell from the installed `@deepseek-ai/dsh-api-terminal-controller` Client
 * service (`ctx.webTerminals`). The plugin owns no PTY: process lifetime, screen
 * recovery and reconnection stay with that service, and this bundle is only the
 * emulator, the tab/split bookkeeping and the remembered layout.
 *
 * The workspace is GLOBAL: one tab strip for the whole app, not one per
 * conversation. The terminal service still allocates a shell under a Session,
 * so the panel latches one internal anchor Session for its shells and never
 * shows or rebinds it.
 *
 * Two structural rules from the loader shape this file:
 *   - It runs from `client/client.js` and may require only the platform module
 *     table (`react`, `react/jsx-runtime`); no Harness Client package is
 *     imported at runtime, and no JSX build step exists, so `h()` is used
 *     directly.
 *   - xterm is ~480 KiB and must not sit in this bundle: it lives in the
 *     package-local chunk `client/client.xterm.js`, fetched through
 *     `require.async('./client.xterm.js')` the first time a pane mounts.
 *
 * Shells stay alive because the terminal service owns the process, not because
 * of any window hold from this plugin: the service's `retainTabs` list is a
 * single last-writer field that the shipped right-sidebar terminal also writes,
 * so a second writer would evict that plugin's holds on every tab change. This
 * plugin therefore never touches it and accepts the service's unattended
 * reclamation of a shell left idle for two hours with no attached screen.
 */
window.__ModuleLoader__.load({
  id: 'dsh-terminal-workspace',
  factory(require) {
    const React = require('react')
    const {
      createElement: h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    const PACKAGE = 'dsh-terminal-workspace'
    const NS = 'terminalWorkspace'
    /** One workspace for the whole app — not one per conversation. */
    const STORAGE_KEY = 'dsh.terminal-workspace.v2'
    /** The Session id that hosts this workspace's shells; an implementation detail. */
    const ANCHOR_KEY = 'dsh.terminal-workspace.anchor'
    /** Last known screen text per pane, so a Host restart does not erase history. */
    const HISTORY_PREFIX = 'dsh.terminal-workspace.hist.v1:'
    /** Kept per pane: enough to see what ran, small enough for `localStorage`. */
    const HISTORY_MAX_LINES = 300
    const HISTORY_MAX_CHARS = 24_000
    const PANEL_ID = 'terminal-workspace'

    // ── layout model ───────────────────────────────────────────────────────

    function uid() {
      return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `tw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    const isLeaf = node => node !== undefined && node !== null && node.kind === 'leaf'
    const isSplit = node => node !== undefined && node !== null && node.kind === 'split'

    /** Every leaf of one subtree, left to right. */
    function leavesOf(node) {
      if (isLeaf(node)) return [node]
      if (!isSplit(node)) return []
      return node.children.flatMap(leavesOf)
    }

    const firstLeaf = node => leavesOf(node)[0]
    const containsLeaf = (node, paneId) => leavesOf(node).some(leaf => leaf.id === paneId)

    /** Replace one leaf's identity, keeping its place in the tree. */
    function mapLeaf(node, paneId, change) {
      if (isLeaf(node)) return node.id === paneId ? change(node) : node
      if (!isSplit(node)) return node
      return { ...node, children: node.children.map(child => mapLeaf(child, paneId, change)) }
    }

    /** Keep a pane large enough to type in while still allowing a wide split. */
    function clampRatio(ratio) {
      return Math.min(0.85, Math.max(0.15, ratio))
    }

    /** Replace one split's first-child share, keeping its place in the tree. */
    function mapSplit(node, splitId, change) {
      if (!isSplit(node)) return node
      const next = node.id === splitId ? change(node) : node
      return { ...next, children: next.children.map(child => mapSplit(child, splitId, change)) }
    }

    /** Replace one leaf with a split holding that leaf and a new sibling. */
    function splitLeaf(node, paneId, direction, sibling) {
      if (isLeaf(node)) {
        if (node.id !== paneId) return node
        return { kind: 'split', id: uid(), direction, ratio: 0.5, children: [node, sibling] }
      }
      if (!isSplit(node)) return node
      return { ...node, children: node.children.map(child => splitLeaf(child, paneId, direction, sibling)) }
    }

    /**
     * Remove one leaf, collapsing a split that loses a side.
     * @returns the replacement subtree, or undefined when the leaf was the root.
     */
    function removeLeaf(node, paneId) {
      if (isLeaf(node)) return node.id === paneId ? undefined : node
      if (!isSplit(node)) return node
      const kept = []
      for (const child of node.children) {
        const next = removeLeaf(child, paneId)
        if (next !== undefined) kept.push(next)
      }
      if (kept.length === node.children.length) return node
      if (kept.length === 0) return undefined
      if (kept.length === 1) return kept[0]
      return { ...node, children: kept }
    }

    /** A fresh tab: one unsplit pane with a fresh content identity. */
    function newTab() {
      const leaf = { kind: 'leaf', id: uid(), contentId: uid() }
      return { id: uid(), root: leaf, activePaneId: leaf.id }
    }

    /** The service's occurrence key for one pane; stable across reloads. */
    const paneKey = contentId => `tw:${contentId}`

    // ── remembered workspace ───────────────────────────────────────────────

    /** Normalize one stored subtree; anything unrecognizable is dropped. */
    function normalizeNode(raw) {
      if (typeof raw !== 'object' || raw === null) return undefined
      if (raw.kind === 'leaf') {
        return {
          kind: 'leaf',
          id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : uid(),
          contentId: typeof raw.contentId === 'string' && raw.contentId !== '' ? raw.contentId : uid(),
        }
      }
      if (raw.kind === 'split' && Array.isArray(raw.children)) {
        const children = raw.children.map(normalizeNode).filter(child => child !== undefined)
        if (children.length === 0) return undefined
        if (children.length === 1) return children[0]
        return {
          kind: 'split',
          id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : uid(),
          direction: raw.direction === 'column' ? 'column' : 'row',
          ratio: typeof raw.ratio === 'number' && Number.isFinite(raw.ratio)
            ? clampRatio(raw.ratio)
            : 0.5,
          children,
        }
      }
      return undefined
    }

    /**
     * Read the remembered workspace. The tab and pane identities are what let
     * the terminal service reattach each pane to the shell it already owns
     * after a reload.
     * @returns the saved workspace, or undefined when there is none.
     */
    function readWorkspace() {
      let raw
      try {
        raw = localStorage.getItem(STORAGE_KEY)
      } catch {
        return undefined
      }
      if (raw === null) return undefined
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.tabs)) return undefined
        const tabs = []
        for (const entry of parsed.tabs) {
          if (typeof entry !== 'object' || entry === null) continue
          const root = normalizeNode(entry.root)
          if (root === undefined) continue
          tabs.push({
            id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : uid(),
            ...(typeof entry.title === 'string' && entry.title !== '' ? { title: entry.title } : {}),
            root,
            activePaneId: typeof entry.activePaneId === 'string' && containsLeaf(root, entry.activePaneId)
              ? entry.activePaneId
              : firstLeaf(root).id,
          })
        }
        const activeTabId = tabs.some(tab => tab.id === parsed.activeTabId) ? parsed.activeTabId : tabs[0]?.id
        return { tabs, activeTabId }
      } catch {
        return undefined
      }
    }

    function serializeWorkspace(workspace) {
      return JSON.stringify({
        activeTabId: workspace.activeTabId,
        tabs: workspace.tabs.map(tab => ({
          id: tab.id,
          ...(tab.title === undefined ? {} : { title: tab.title }),
          root: tab.root,
          activePaneId: tab.activePaneId,
        })),
      })
    }

    // ── screen history ─────────────────────────────────────────────────────

    /**
     * The plain text of a pane's last screen, newest lines kept.
     *
     * A shell's PTY dies with the Host process, and the service only retains
     * screens for terminals it still owns, so after a restart the pane would be
     * blank. This is what the panel replays instead.
     * @param xterm - the pane's emulator.
     * @returns trimmed text, capped to the configured lines and characters.
     */
    function snapshotText(xterm) {
      const buffer = xterm?.buffer?.active
      if (buffer === undefined) return ''
      const total = buffer.length
      const from = Math.max(0, total - HISTORY_MAX_LINES)
      const lines = []
      for (let index = from; index < total; index++) {
        const line = buffer.getLine(index)
        lines.push(line === undefined ? '' : line.translateToString(true))
      }
      // Trailing blank rows are the empty tail of the viewport, not content.
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      let text = lines.join('\n')
      if (text.length > HISTORY_MAX_CHARS) text = text.slice(text.length - HISTORY_MAX_CHARS)
      return text
    }

    function readHistory(contentId) {
      try {
        const raw = localStorage.getItem(HISTORY_PREFIX + contentId)
        return raw === null || raw === '' ? undefined : raw
      } catch {
        return undefined
      }
    }

    function writeHistory(contentId, text) {
      try {
        localStorage.setItem(HISTORY_PREFIX + contentId, text)
      } catch {
        // Quota or a blocked store: the live screen still works, only the
        // post-restart replay is lost. Never let that break a keystroke path.
      }
    }

    function forgetHistory(contentId) {
      try {
        localStorage.removeItem(HISTORY_PREFIX + contentId)
      } catch {}
    }

    // ── terminal service ───────────────────────────────────────────────────

    /**
     * Build the small, stable surface the components use: terminal model
     * lookup, process cleanup, the resolved theme, the open-pane report the
     * service needs to hold shells, and the last shown Session.
     * @param ctx - plugin Client Context.
     * @returns the injected face.
     */
    /** Latest theme snapshot and its subscribers, shared by every pane. */
    let themeSnapshot
    const themeListeners = new Set()
    const push = () => { for (const listener of themeListeners) listener() }

    function createFace(ctx) {
      const service = () => {
        const found = ctx.get('webTerminals')
        return found === undefined || typeof found.view !== 'function' ? undefined : found
      }
      return {
        available: () => service() !== undefined,
        /** The stable view for one pane; a repeat call for the same key is free. */
        view(sessionId, contentId) {
          const found = service()
          if (found === undefined) return undefined
          try {
            return found.view(sessionId, paneKey(contentId), contentId)
          } catch {
            return undefined
          }
        },
        /** End one pane's process; a shell that already exited needs nothing. */
        close(sessionId, contentId) {
          const found = service()
          if (found === undefined) return
          try {
            found.close(sessionId, paneKey(contentId), contentId)
          } catch {
            // The identity was already gone.
          }
        },
        /**
         * One shared theme source. The subscription is installed once by
         * `startTheme` on the plugin context, so a remounting pane never adds a
         * listener, and plugin unload removes it.
         */
        theme: {
          getSnapshot: () => themeSnapshot,
          subscribe(listener) {
            themeListeners.add(listener)
            return () => { themeListeners.delete(listener) }
          },
          start() {
            const read = () => ctx.get('theme')?.getTheme?.()
            themeSnapshot = read()
            themeListeners.add(push)
            const off = ctx.on('theme/change', () => {
              themeSnapshot = read()
              push()
            })
            return () => { off(); themeListeners.delete(push) }
          },
        },
        /** The Session whose shells this workspace owns (internal; never shown). */
        anchor() {
          try {
            return localStorage.getItem(ANCHOR_KEY) ?? undefined
          } catch {
            return undefined
          }
        },
        setAnchor(sessionId) {
          try {
            localStorage.setItem(ANCHOR_KEY, sessionId)
          } catch {}
        },
      }
    }

    // ── xterm chunk ────────────────────────────────────────────────────────

    let xtermPromise
    let xtermStyles

    /**
     * Fetch the package-local xterm chunk once and install its stylesheet.
     * @returns the emulator constructor and the fit addon.
     */
    function loadXterm() {
      if (xtermPromise !== undefined) return xtermPromise
      const attempt = require.async('./client.xterm.js').then(lib => {
        if (lib === null || typeof lib !== 'object' || typeof lib.Terminal !== 'function') {
          throw new Error('xterm chunk did not export a Terminal constructor')
        }
        if (xtermStyles === undefined && typeof lib.css === 'string') {
          const tag = document.createElement('style')
          tag.dataset.plugin = PACKAGE
          tag.dataset.pluginCss = `${PACKAGE}/xterm.css`
          tag.textContent = lib.css
          document.head.append(tag)
          xtermStyles = tag
        }
        return lib
      })
      // A rejection must not be cached: the next mount would reuse the failed
      // promise and the screen could never load again without a page reload.
      xtermPromise = attempt
      attempt.catch(() => { if (xtermPromise === attempt) xtermPromise = undefined })
      return attempt
    }

    const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const fontFamilyOf = theme => {
      const list = theme?.fontFamilies?.terminal ?? ''
      return list === '' ? FONT_STACK : `${list}, ${FONT_STACK}`
    }
    const fontSizeOf = theme => theme?.fontSizes?.terminal ?? 12

    /** Read the resolved DSH colors the emulator should paint with. */
    function paletteOf(node) {
      const style = getComputedStyle(node)
      const background = style.getPropertyValue('--dsw-alias-bg-base').trim() || style.backgroundColor
      const foreground = style.getPropertyValue('--dsw-alias-label-primary').trim() || style.color
      return {
        background,
        foreground,
        cursor: foreground,
        cursorAccent: background,
        selectionBackground: foreground,
        selectionForeground: background,
      }
    }

    /** Resize both the emulator grid and the Host terminal to the visible box. */
    function fitScreen(xterm, fit, state, model) {
      if (xterm === undefined || fit === undefined || model === undefined || state === undefined) return
      const environment = state.environment
      if (environment === undefined) return
      const proposed = fit.proposeDimensions()
      if (proposed === undefined || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return
      const cols = Math.min(proposed.cols, environment.maxCols)
      const rows = Math.min(proposed.rows, environment.maxRows)
      if (cols < 2 || rows < 1) return
      if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows)
      model.resize(cols, rows)
    }

    /**
     * Screens change per output chunk; writing every one to `localStorage`
     * would tax the main thread. One pending save per pane, trailing.
     */
    const pendingSaves = new Map()
    function scheduleHistorySave(contentId, xterm) {
      const previous = pendingSaves.get(contentId)
      if (previous !== undefined) clearTimeout(previous)
      pendingSaves.set(contentId, setTimeout(() => {
        pendingSaves.delete(contentId)
        writeHistory(contentId, snapshotText(xterm))
      }, 800))
    }
    function flushHistorySave(contentId, xterm) {
      const previous = pendingSaves.get(contentId)
      if (previous !== undefined) { clearTimeout(previous); pendingSaves.delete(contentId) }
      writeHistory(contentId, snapshotText(xterm))
    }

    // ── glyphs ─────────────────────────────────────────────────────────────

    const GLYPH_PLUS = 'M8 3.4v9.2M3.4 8h9.2'
    const GLYPH_SPLIT_RIGHT = 'M2.6 3h10.8v10H2.6zM8 3v10'
    const GLYPH_SPLIT_DOWN = 'M2.6 3h10.8v10H2.6zM2.6 8h10.8'
    const GLYPH_CLOSE = 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2'

    /** The sidebar row's glyph: a prompt chevron with a caret block. */
    function TerminalWorkspaceIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', {
          d: 'M2.6 3.6 6.4 7.4 2.6 11.2',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8.2 11.4h4.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    function Glyph({ path }) {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: path, stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /** Small square icon button used by the panel chrome. */
    function IconButton({ label, onClick, children }) {
      return h('button', {
        type: 'button',
        className: 'twp-iconButton',
        title: label,
        'aria-label': label,
        onClick,
      }, children)
    }

    // ── pane ───────────────────────────────────────────────────────────────

    /**
     * Render one pane: its header, its status line, and the emulator screen.
     * @param props - pane identity, the displayed Session, visibility, and actions.
     */
    function Pane({
      face, sessionId, leaf, active, t,
      onActivate, onSplit, onClose, onRestart,
    }) {
      const screenRef = useRef(null)
      const terminalRef = useRef(undefined)
      const fitRef = useRef(undefined)
      const lastRevision = useRef(0)
      const [library, setLibrary] = useState(null)
      const [loadError, setLoadError] = useState(undefined)
      const [editing, setEditing] = useState(false)
      const [draftTitle, setDraftTitle] = useState('')
      const [historyShown, setHistoryShown] = useState(false)

      const historyShownRef = useRef(false)
      historyShownRef.current = historyShown
      const model = useMemo(() => face.view(sessionId, leaf.contentId), [face, sessionId, leaf.contentId])
      const subscribe = useCallback(listener => (model === undefined ? () => {} : model.state.subscribe(listener)), [model])
      const snapshot = useCallback(() => (model === undefined ? undefined : model.state.getSnapshot()), [model])
      const state = useSyncExternalStore(subscribe, snapshot, snapshot)
      const theme = useSyncExternalStore(face.theme.subscribe, face.theme.getSnapshot, face.theme.getSnapshot)

      useEffect(() => {
        let live = true
        loadXterm().then(
          lib => { if (live) setLibrary(lib) },
          error => { if (live) setLoadError(error instanceof Error ? error : new Error(String(error))) },
        )
        return () => { live = false }
      }, [])

      // The DOM lifetime only; the shell keeps running after unmount.
      useEffect(() => {
        if (model === undefined) return undefined
        return model.mount()
      }, [model])

      const fontFamily = fontFamilyOf(theme)
      const fontSize = fontSizeOf(theme)
      const latest = useRef({ active, fontFamily, fontSize, state })
      latest.current = { active, fontFamily, fontSize, state }

      useLayoutEffect(() => {
        const node = screenRef.current
        if (library === null || node === null || model === undefined) return undefined
        const live = latest.current
        const xterm = new library.Terminal({
          minimumContrastRatio: 4.5,
          cursorBlink: true,
          fontSize: live.fontSize,
          fontFamily: live.fontFamily,
          scrollback: live.state?.environment?.scrollback ?? 1000,
          theme: paletteOf(node),
        })
        const fit = new library.FitAddon()
        xterm.loadAddon(fit)
        xterm.open(node)
        terminalRef.current = xterm
        fitRef.current = fit
        lastRevision.current = 0
        const gestures = ['keydown', 'beforeinput', 'paste', 'compositionend', 'drop', 'mousedown', 'touchstart']
        let gestureAt = Number.NEGATIVE_INFINITY
        const gesture = () => { gestureAt = performance.now() }
        for (const type of gestures) node.addEventListener(type, gesture, { capture: true, passive: true })
        const input = xterm.onData((data) => {
          model.write(data, performance.now() - gestureAt < 250)
        })
        // Give each screen a distinct accessible name; xterm's own default is
        // the same generic label for every emulator on the page.
        xterm.textarea?.setAttribute('aria-label', live.state?.title ?? t('pane.untitled'))
        const measure = () => {
          const now = latest.current
          if (!now.active || now.state?.writable !== true) return
          fitScreen(xterm, fit, now.state, model)
        }
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        // Show the last screen this pane had, before any live frame arrives. A
        // running shell overwrites it with its own snapshot within a moment; a
        // shell that died with a Host restart leaves this as the only record.
        const replay = readHistory(leaf.contentId)
        if (replay !== undefined && replay !== '') {
          xterm.write(replay.replace(/\n/g, '\r\n'))
          setHistoryShown(true)
        }
        return () => {
          observer.disconnect()
          for (const type of gestures) node.removeEventListener(type, gesture, { capture: true })
          input.dispose()
          // Save the final screen on the way out: unmount is not a close, and the
          // pane may come back after a reload.
          if (latest.current.state?.info !== undefined) flushHistorySave(leaf.contentId, xterm)
          xterm.dispose()
          terminalRef.current = undefined
          fitRef.current = undefined
        }
      }, [library, model, leaf.contentId])

      // The screen paints from the resolved theme tokens.
      useLayoutEffect(() => {
        const xterm = terminalRef.current
        const node = screenRef.current
        if (xterm === undefined || node === null) return
        xterm.options.theme = paletteOf(node)
      }, [theme])

      useLayoutEffect(() => {
        const xterm = terminalRef.current
        if (xterm === undefined) return
        if (xterm.options.fontFamily === fontFamily && xterm.options.fontSize === fontSize) return
        xterm.options.fontFamily = fontFamily
        xterm.options.fontSize = fontSize
        if (latest.current.active && latest.current.state?.writable === true && screenRef.current !== null) {
          fitScreen(xterm, fitRef.current, latest.current.state, model)
        }
      }, [fontFamily, fontSize, model])

      // Replay a recovered screen, then append ordered output; acknowledging a
      // frame is what releases the next one.
      useLayoutEffect(() => {
        const xterm = terminalRef.current
        const render = state?.render
        if (xterm === undefined || render === undefined || render.revision <= lastRevision.current) return
        lastRevision.current = render.revision
        if (render.frame.type === 'snapshot') {
          xterm.reset()
          xterm.resize(render.frame.info.cols, render.frame.info.rows)
        }
        xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => {
          model.acknowledge(render.revision)
          // The replayed text is superseded by the real screen as soon as one
          // arrives, so stop labelling the pane as history.
          if (historyShownRef.current) { historyShownRef.current = false; setHistoryShown(false) }
          scheduleHistorySave(leaf.contentId, xterm)
        })
      }, [state?.render, model, leaf.contentId])

      useLayoutEffect(() => {
        const xterm = terminalRef.current
        if (xterm === undefined) return
        xterm.options.disableStdin = state?.writable !== true
        if (active && state?.writable === true && screenRef.current !== null) {
          fitScreen(xterm, fitRef.current, state, model)
        } else if (state?.info !== undefined) {
          xterm.resize(state.info.cols, state.info.rows)
        }
      }, [active, state?.writable, state?.info?.cols, state?.info?.rows, model])

      useEffect(() => {
        if (active && state?.writable === true) terminalRef.current?.focus()
      }, [active, state?.writable])

      useEffect(() => {
        const info = state?.info
        if (info === undefined) return
        terminalRef.current?.textarea?.setAttribute('aria-label', info.title)
      }, [state?.info?.title])

      const info = state?.info
      const hasHistory = historyShown
      const exited = info?.state === 'exited'
      const failed = info?.state === 'failed'
      const issue = state?.issue
      let status
      if (loadError !== undefined) status = t('pane.chunkFailed', { message: loadError.message })
      else if (model === undefined) status = t('pane.noService')
      else if (state === undefined || state.phase === 'idle' || state.phase === 'loading') status = t('pane.loading')
      else if (state.phase === 'creating') status = t('pane.creating')
      else if (state.phase === 'connecting') status = t('pane.connecting')
      else if (state.phase === 'disconnected' || issue === 'attachmentEnded') status = t('pane.disconnected')
      else if (exited) status = t('pane.exited', { code: String(info?.exitCode ?? '—') })
      else if (failed) {
        status = state?.error === undefined
          ? t('pane.failed')
          : t('pane.failedWith', { message: state.error })
      }
      else if (issue === 'terminalLimit') status = t('pane.limit')
      else if (issue === 'missingTerminal') status = t('pane.missing')
      else if (issue === 'inputFull') status = t('pane.inputFull')

      const screenRetry = loadError !== undefined
      const recoverable = model !== undefined && !screenRetry && (exited || failed || issue === 'missingTerminal')
      const retrying = model !== undefined && !recoverable && (state?.phase === 'failed' || state?.phase === 'disconnected')
      const readOnly = state?.phase === 'connected' && info?.state === 'running' && state?.writable !== true
      const title = info?.title !== undefined && info.title !== '' ? info.title : t('pane.untitled')

      return h('section', {
        className: `twp-pane${active ? ' twp-pane-active' : ''}`,
        'data-pane': leaf.id,
        onMouseDownCapture: onActivate,
      },
        h('header', { className: 'twp-paneHead' },
          editing
            ? h('input', {
              className: 'twp-titleInput',
              value: draftTitle,
              autoFocus: true,
              'aria-label': t('pane.rename'),
              onChange: event => setDraftTitle(event.target.value),
              onBlur: () => {
                setEditing(false)
                const next = draftTitle.trim()
                if (next !== '' && next !== title) Promise.resolve(model?.rename?.(next)).catch(() => {})
              },
              onKeyDown: event => {
                if (event.key === 'Enter') event.currentTarget.blur()
                else if (event.key === 'Escape') { setDraftTitle(title); setEditing(false) }
              },
            })
            : h('span', {
              className: 'twp-paneTitle',
              title: t('pane.renameHint'),
              role: 'button',
              tabIndex: 0,
              onDoubleClick: () => { setDraftTitle(title); setEditing(true) },
              onKeyDown: event => {
                if (event.key === 'F2' || event.key === 'Enter') {
                  event.preventDefault()
                  setDraftTitle(title)
                  setEditing(true)
                }
              },
            }, title),
          h('span', { className: 'twp-paneSpacer' }),
          info?.cwd === undefined ? null : h('span', { className: 'twp-paneMeta', title: info.cwd }, info.cwd),
          h(IconButton, { label: t('pane.splitRight'), onClick: () => onSplit('row') }, h(Glyph, { path: GLYPH_SPLIT_RIGHT })),
          h(IconButton, { label: t('pane.splitDown'), onClick: () => onSplit('column') }, h(Glyph, { path: GLYPH_SPLIT_DOWN })),
          h(IconButton, { label: t('pane.close'), onClick: onClose }, h(Glyph, { path: GLYPH_CLOSE })),
        ),
        hasHistory ? h('div', { className: 'twp-historyNote', role: 'note' },
          h('span', { className: 'twp-statusText' }, t('pane.history')),
          h('button', {
            type: 'button',
            className: 'twp-linkButton',
            onClick: () => {
              forgetHistory(leaf.contentId)
              setHistoryShown(false)
              const xterm = terminalRef.current
              if (xterm !== undefined) { xterm.clear(); xterm.reset() }
            },
          }, t('pane.historyClear')),
        ) : null,
        status === undefined && !retrying && !readOnly ? null : h('div', { className: 'twp-paneStatus', role: 'status' },
          h('span', { className: 'twp-statusText' }, status ?? t('pane.waiting')),
          screenRetry ? h('button', {
            type: 'button',
            className: 'twp-linkButton',
            onClick: () => {
              setLoadError(undefined)
              loadXterm().then(lib => setLibrary(lib), error => setLoadError(error instanceof Error ? error : new Error(String(error))))
            },
          }, t('pane.retryScreen')) : null,
          readOnly ? h('button', { type: 'button', className: 'twp-linkButton', onClick: () => model.connect() }, t('pane.takeControl')) : null,
          retrying ? h('button', {
            type: 'button',
            className: 'twp-linkButton',
            onClick: () => (info === undefined ? model.refresh() : model.connect()),
          }, t('pane.reconnect')) : null,
          issue === 'terminalLimit' ? h('button', { type: 'button', className: 'twp-linkButton', onClick: onClose }, t('pane.closeThis')) : null,
          recoverable ? h('button', { type: 'button', className: 'twp-linkButton', onClick: onRestart }, t('pane.newTerminal')) : null,
        ),
        h('div', { className: 'twp-screen', ref: screenRef }),
      )
    }

    /** One tab's pane tree, laid out with flex splits. */
    function PaneNode({ face, sessionId, node, activePaneId, t, actions }) {
      if (isLeaf(node)) {
        return h(Pane, {
          key: node.id,
          face,
          sessionId,
          leaf: node,
          active: node.id === activePaneId,
          t,
          onActivate: () => actions.activatePane(node.id),
          onSplit: direction => actions.split(node.id, direction),
          onClose: () => actions.closePane(node.id),
          onRestart: () => actions.restart(node.id),
        })
      }
      const vertical = node.direction === 'column'
      const ratio = node.ratio ?? 0.5
      const parts = []
      node.children.forEach((child, index) => {
        if (index > 0) {
          parts.push(h('div', {
            key: `gutter-${child.id}`,
            className: `twp-gutter${vertical ? ' twp-gutter-column' : ''}`,
            role: 'separator',
            'aria-orientation': vertical ? 'horizontal' : 'vertical',
            'aria-label': t('split.resize'),
            onPointerDown: event => {
              const splitElement = event.currentTarget.parentElement
              if (splitElement === null) return
              event.preventDefault()
              const move = e => {
                const bounds = splitElement.getBoundingClientRect()
                const total = vertical ? bounds.height : bounds.width
                if (total <= 0) return
                const offset = vertical ? e.clientY - bounds.top : e.clientX - bounds.left
                actions.resizeSplit(node.id, offset / total)
              }
              const stop = () => {
                document.removeEventListener('pointermove', move)
                document.removeEventListener('pointerup', stop)
                document.removeEventListener('pointercancel', stop)
              }
              document.addEventListener('pointermove', move)
              document.addEventListener('pointerup', stop)
              document.addEventListener('pointercancel', stop)
            },
          }))
        }
        parts.push(h('div', {
          key: child.id,
          className: 'twp-splitCell',
          // Grow shares are proportional to the stored ratio; flex-basis 0 keeps
          // the arithmetic exact regardless of each pane's content.
          style: { flexGrow: String(index === 0 ? ratio * 100 : (1 - ratio) * 100) },
        }, h(PaneNode, { face, sessionId, node: child, activePaneId, t, actions })))
      })
      return h('div', {
        className: `twp-split${vertical ? ' twp-split-column' : ''}`,
      }, parts)
    }

    // ── panel ──────────────────────────────────────────────────────────────

    /**
     * The main panel: one tab strip over the active tab's pane tree. The
     * workspace is global — it is not tied to the conversation on screen — and
     * only the active tab is mounted, so a hidden tab releases its screens
     * while the terminal service keeps the shells alive.
     * @param props - slot props (`useSessions`, `t`) plus the injected face.
     */
    function TerminalWorkspacePanel({ useSessions, face, t }) {
      // The host terminal service allocates a PTY for a Session, so the
      // workspace owns exactly one: the *anchor* Session, chosen once and then
      // kept. Switching conversations must never rebind or reset the layout.
      const list = useSessions(state => state)
      // Latched once: the shells live under this Session for as long as the
      // panel is mounted, so a disappearing conversation can never rebind them.
      // An unresolved latch stays open until some Session exists, which is what
      // lets a fresh app session recover without a reload.
      const latched = useRef(undefined)
      if (latched.current === undefined || latched.current === null) {
        const rows = Object.values(list.byId ?? {}).filter(row => row !== undefined && row.origin !== 'subagent')
        const saved = face.anchor()
        const main = rows.find(row => (row.retainedBy?.mainView ?? 0) > 0)
        latched.current = saved
          ?? main?.id
          ?? rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]?.id
          ?? null
      }
      const anchor = latched.current === null ? undefined : latched.current

      useEffect(() => {
        if (anchor !== undefined) face.setAnchor(anchor)
      }, [anchor])

      const [workspace, setWorkspace] = useState(undefined)
      const [renaming, setRenaming] = useState(undefined)
      const written = useRef(undefined)

      // Loaded once per anchor. The anchor is latched above, so in practice this
      // runs a single time; the guard keeps a stray re-resolution from discarding
      // a layout the user just built.
      const loadedFor = useRef(undefined)
      useEffect(() => {
        if (anchor === undefined) { setWorkspace(undefined); return }
        if (loadedFor.current === anchor) return
        loadedFor.current = anchor
        written.current = undefined
        setRenaming(undefined)
        setWorkspace(readWorkspace() ?? { tabs: [newTab()], activeTabId: undefined })
      }, [anchor])

      /** The Session whose shells every pane in this workspace belongs to. */
      const sessionId = anchor

      const activeTab = workspace?.tabs.find(tab => tab.id === workspace.activeTabId) ?? workspace?.tabs[0]

      // An overflowing strip hides its scrollbar, so a newly active tab must be
      // scrolled into view or `+` looks broken.
      useEffect(() => {
        if (activeTab === undefined) return
        document.getElementById(`twp-tab-${activeTab.id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      }, [activeTab?.id, workspace?.tabs.length])

      // Persist, then repair a stored active-tab id that no longer exists.
      useEffect(() => {
        if (workspace === undefined) return
        if (activeTab !== undefined && activeTab.id !== workspace.activeTabId) {
          setWorkspace({ ...workspace, activeTabId: activeTab.id })
          return
        }
        const payload = serializeWorkspace(workspace)
        if (written.current === payload) return
        written.current = payload
        try {
          localStorage.setItem(STORAGE_KEY, payload)
        } catch {
          // Storage is full or blocked: the layout simply is not restored later.
        }
      }, [workspace, activeTab])

      /** One mutation helper per action keeps the tree rules in a single place. */
      const actions = useMemo(() => {
        const mutate = change => setWorkspace(state => (state === undefined ? state : change(state)))
        return {
          activateTab(tabId) {
            mutate(state => ({ ...state, activeTabId: tabId }))
          },
          renameTab(tabId, title) {
            mutate(state => ({
              ...state,
              tabs: state.tabs.map(tab => {
                if (tab.id !== tabId) return tab
                const next = { ...tab }
                if (title === undefined || title === '') delete next.title
                else next.title = title
                return next
              }),
            }))
          },
          addTab() {
            const tab = newTab()
            mutate(state => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }))
          },
          closeTab(tabId) {
            mutate(state => {
              const closing = state.tabs.find(tab => tab.id === tabId)
              if (closing !== undefined && sessionId !== undefined) {
                for (const leaf of leavesOf(closing.root)) {
                  face.close(sessionId, leaf.contentId)
                  forgetHistory(leaf.contentId)
                }
              }
              const index = state.tabs.findIndex(tab => tab.id === tabId)
              const tabs = state.tabs.filter(tab => tab.id !== tabId)
              // Neighbour, not tab 1: closing a tab in the middle must not throw
              // the user's place away.
              const neighbour = tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id
              return {
                tabs,
                activeTabId: state.activeTabId === tabId ? neighbour : state.activeTabId,
              }
            })
          },
          activatePane(paneId) {
            mutate(state => ({
              ...state,
              tabs: state.tabs.map(tab => (tab.id === state.activeTabId ? { ...tab, activePaneId: paneId } : tab)),
            }))
          },
          split(paneId, direction) {
            const sibling = { kind: 'leaf', id: uid(), contentId: uid() }
            mutate(state => ({
              ...state,
              tabs: state.tabs.map(tab => (tab.id === state.activeTabId
                ? { ...tab, root: splitLeaf(tab.root, paneId, direction, sibling), activePaneId: sibling.id }
                : tab)),
            }))
          },
          closePane(paneId) {
            mutate(state => {
              const tab = state.tabs.find(entry => entry.id === state.activeTabId)
              if (tab === undefined) return state
              const target = leavesOf(tab.root).find(leaf => leaf.id === paneId)
              if (target !== undefined && sessionId !== undefined) {
                face.close(sessionId, target.contentId)
                forgetHistory(target.contentId)
              }
              const root = removeLeaf(tab.root, paneId)
              if (root === undefined) {
                const index = state.tabs.findIndex(entry => entry.id === tab.id)
                const tabs = state.tabs.filter(entry => entry.id !== tab.id)
                return { tabs, activeTabId: tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id }
              }
              return {
                ...state,
                tabs: state.tabs.map(entry => (entry.id === tab.id
                  ? {
                    ...entry,
                    root,
                    activePaneId: containsLeaf(root, entry.activePaneId) ? entry.activePaneId : firstLeaf(root).id,
                  }
                  : entry)),
              }
            })
          },
          resizeSplit(splitId, ratio) {
            mutate(state => ({
              ...state,
              tabs: state.tabs.map(tab => (tab.id === state.activeTabId
                ? { ...tab, root: mapSplit(tab.root, splitId, split => ({ ...split, ratio: clampRatio(ratio) })) }
                : tab)),
            }))
          },
          restart(paneId) {
            mutate(state => {
              const tab = state.tabs.find(entry => entry.id === state.activeTabId)
              const previous = tab === undefined ? undefined : leavesOf(tab.root).find(leaf => leaf.id === paneId)
              // Release the dead identity first: otherwise its view stays
              // registered under a key nothing will mount again. The new pane
              // starts clean rather than inheriting a dead shell's screen.
              if (previous !== undefined && sessionId !== undefined) {
                face.close(sessionId, previous.contentId)
                forgetHistory(previous.contentId)
              }
              return {
                ...state,
                tabs: state.tabs.map(entry => (entry.id === state.activeTabId
                  ? { ...entry, root: mapLeaf(entry.root, paneId, leaf => ({ ...leaf, contentId: uid() })) }
                  : entry)),
              }
            })
          },
        }
      }, [face, sessionId])

      // iTerm2's split chords. On macOS they are ⌘D / ⌘⇧D; elsewhere Alt+Shift+D
      // and Alt+Shift+E, because Ctrl+D is the shell's end-of-file.
      const surfaceRef = useRef(null)
      useEffect(() => {
        const node = surfaceRef.current
        if (node === null || activeTab === undefined) return undefined
        const paneId = activeTab.activePaneId ?? firstLeaf(activeTab.root).id
        const onKeyDown = event => {
          if (event.repeat) return
          const key = event.key.toLowerCase()
          const mac = event.metaKey && !event.ctrlKey && !event.altKey
          const other = event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey
          if (!mac && !other) return
          if (key !== 'd' && key !== 'e') return
          if (mac && key === 'e') return
          event.preventDefault()
          event.stopPropagation()
          actions.split(paneId, (mac ? event.shiftKey : key === 'e') ? 'column' : 'row')
        }
        node.addEventListener('keydown', onKeyDown, true)
        return () => { node.removeEventListener('keydown', onKeyDown, true) }
      }, [actions, activeTab])

      if (!face.available()) {
        return h('div', { className: 'twp-empty' }, h('p', { className: 'twp-emptyText' }, t('panel.noService')))
      }
      if (sessionId === undefined) {
        return h('div', { className: 'twp-empty' },
          h('p', { className: 'twp-emptyText' }, t('panel.noAnchor')),
          h('p', { className: 'twp-emptyHint' }, t('panel.noAnchorHint')))
      }
      if (workspace === undefined) {
        return h('div', { className: 'twp-empty' }, h('p', { className: 'twp-emptyText' }, t('panel.loading')))
      }

      /** A close tooltip that states the consequence: how many shells end. */
      const closeLabel = tab => {
        const count = leavesOf(tab.root).length
        return count > 1 ? t('panel.closeTabShells', { count: String(count) }) : t('panel.closeTab')
      }

      return h('section', { className: 'twp-root', ref: surfaceRef, 'data-terminal-workspace': '' },
        h('header', { className: 'twp-bar' },
          h('span', { className: 'twp-title' }, t('panel.title')),
          h('div', {
            className: 'twp-tabs',
            role: 'tablist',
            'aria-label': t('panel.tabs'),
            'aria-description': t('panel.tabHint'),
          },
            workspace.tabs.map((tab, index) => {
              const selected = tab.id === activeTab?.id
              const label = tab.title ?? t('panel.tab', { n: String(index + 1) })
              return h('div', {
                key: tab.id,
                className: `twp-tab${selected ? ' twp-tab-active' : ''}`,
                role: 'tab',
                tabIndex: selected ? 0 : -1,
                'aria-selected': selected,
                title: label,
                onClick: () => actions.activateTab(tab.id),
                onDoubleClick: () => setRenaming(tab.id),
                onAuxClick: event => { if (event.button === 1) actions.closeTab(tab.id) },
                id: `twp-tab-${tab.id}`,
                'aria-controls': `twp-panel-${tab.id}`,
                onKeyDown: event => {
                  const count = workspace.tabs.length
                  const move = next => {
                    event.preventDefault()
                    const target = workspace.tabs[next]
                    if (target === undefined) return
                    actions.activateTab(target.id)
                    document.getElementById(`twp-tab-${target.id}`)?.focus()
                  }
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.activateTab(tab.id) }
                  else if (event.key === 'F2') { event.preventDefault(); setRenaming(tab.id) }
                  else if (event.key === 'ArrowLeft') move((index - 1 + count) % count)
                  else if (event.key === 'ArrowRight') move((index + 1) % count)
                  else if (event.key === 'Home') move(0)
                  else if (event.key === 'End') move(count - 1)
                },
              },
                h('span', { className: 'twp-tabGlyph', 'aria-hidden': true }, h(TerminalWorkspaceIcon, { size: 13 })),
                renaming === tab.id
                  ? h('input', {
                    className: 'twp-tabInput',
                    defaultValue: tab.title ?? '',
                    autoFocus: true,
                    'aria-label': t('panel.renameTab'),
                    onClick: event => event.stopPropagation(),
                    onBlur: event => {
                      actions.renameTab(tab.id, event.target.value.trim())
                      setRenaming(undefined)
                    },
                    onKeyDown: event => {
                      event.stopPropagation()
                      if (event.key === 'Enter') event.currentTarget.blur()
                      else if (event.key === 'Escape') { event.currentTarget.value = tab.title ?? ''; event.currentTarget.blur() }
                    },
                  })
                  : h('span', { className: 'twp-tabTitle' }, label),
                h('button', {
                  type: 'button',
                  className: 'twp-tabClose',
                  title: closeLabel(tab),
                  'aria-label': closeLabel(tab),
                  tabIndex: selected ? 0 : -1,
                  onClick: event => { event.stopPropagation(); actions.closeTab(tab.id) },
                }, h(Glyph, { path: GLYPH_CLOSE })),
              )
            }),
          ),
          h('div', { className: 'twp-actions' },
            h(IconButton, { label: t('panel.newTab'), onClick: () => actions.addTab() }, h(Glyph, { path: GLYPH_PLUS })),
          ),
        ),
        h('div', {
          className: 'twp-surface',
          role: 'tabpanel',
          id: `twp-panel-${activeTab?.id ?? 'none'}`,
          'aria-labelledby': activeTab === undefined ? undefined : `twp-tab-${activeTab.id}`,
        },
          activeTab === undefined
            ? h('div', { className: 'twp-empty' },
              h('p', { className: 'twp-emptyText' }, t('panel.noTabs')),
              h('button', {
                type: 'button',
                className: 'twp-primaryButton',
                onClick: () => actions.addTab(),
              }, t('panel.newTab')))
            : h(PaneNode, {
              face,
              sessionId,
              node: activeTab.root,
              activePaneId: activeTab.activePaneId ?? firstLeaf(activeTab.root).id,
              t,
              actions,
            })),
      )
    }

    // ── copy ───────────────────────────────────────────────────────────────

    const LOCALES = {
      en: {
        entry: 'Terminal',
        'panel.title': 'Terminal',
        'panel.tabs': 'Terminal tabs',
        'panel.tab': 'Terminal {n}',
        'panel.tabHint': 'Double-click to rename, middle-click to close',
        'panel.renameTab': 'Rename this tab',
        'panel.newTab': 'New tab',
        'panel.closeTab': 'Close tab (ends its shell)',
        'panel.closeTabShells': 'Close tab (ends {count} shells)',
        'panel.noTabs': 'No terminal is open in this workspace',
        'panel.noAnchor': 'No shell can start yet',
        'panel.noAnchorHint': 'The terminal service allocates shells under a conversation, and this app session has none yet. Send one message in any conversation, then reopen this panel.',
        'panel.noService': 'The terminal service is not installed, so shells cannot start. Enable the built-in terminal bundle first.',
        'split.resize': 'Drag to resize',
        'panel.loading': 'Opening the workspace…',
        'pane.untitled': 'Terminal',
        'pane.rename': 'Shell title',
        'pane.renameHint': 'Double-click or press F2 to rename this shell',
        'pane.splitRight': 'Split right',
        'pane.splitDown': 'Split down',
        'pane.close': 'Close pane (ends its shell)',
        'pane.loading': 'Starting the shell…',
        'pane.creating': 'Allocating the shell…',
        'pane.connecting': 'Connecting…',
        'pane.disconnected': 'Connection lost; the shell keeps running.',
        'pane.exited': 'Shell exited with code {code}.',
        'pane.failed': 'This shell failed.',
        'pane.failedWith': 'This shell failed: {message}',
        'pane.retryScreen': 'Retry',
        'pane.history': 'Showing the last screen from before the restart. Start a new terminal to run commands.',
        'pane.historyClear': 'Clear',
        'pane.closeThis': 'Close this pane',
        'pane.missing': 'This shell is gone (the Host restarted).',
        'pane.limit': 'This Session has reached its terminal limit; exited panes count too. Close one first.',
        'pane.inputFull': 'Input flooded the terminal; it was detached.',
        'pane.noService': 'The terminal service is not available to this pane.',
        'pane.chunkFailed': 'The terminal screen could not load: {message}',
        'pane.takeControl': 'Take control',
        'pane.reconnect': 'Reconnect',
        'pane.newTerminal': 'New terminal',
        'pane.waiting': 'Waiting for the shell…',
      },
      zh: {
        entry: '终端',
        'panel.title': '终端',
        'panel.tabs': '终端标签页',
        'panel.tab': '终端 {n}',
        'panel.tabHint': '双击重命名，中键关闭',
        'panel.renameTab': '重命名这个标签页',
        'panel.newTab': '新建标签页',
        'panel.closeTab': '关闭标签页（结束其 shell）',
        'panel.closeTabShells': '关闭标签页（结束 {count} 个 shell）',
        'panel.noTabs': '这个工作区里还没有终端',
        'panel.noAnchor': '暂时还无法启动 shell',
        'panel.noAnchorHint': '终端服务需要在某个会话名下分配 shell，而当前应用还没有可用会话。请先在任意会话里发一条消息，再回到这个面板。',
        'panel.noService': '终端服务未安装，无法启动 shell。请先启用内置的终端插件。',
        'split.resize': '拖动调整大小',
        'panel.loading': '正在打开工作区…',
        'pane.untitled': '终端',
        'pane.rename': '终端标题',
        'pane.renameHint': '双击或按 F2 重命名这个终端',
        'pane.splitRight': '向右分屏',
        'pane.splitDown': '向下分屏',
        'pane.close': '关闭分屏（结束该 shell）',
        'pane.loading': '正在启动 shell…',
        'pane.creating': '正在分配 shell…',
        'pane.connecting': '正在连接…',
        'pane.disconnected': '连接已断开；shell 仍在运行。',
        'pane.exited': 'shell 已退出，退出码 {code}。',
        'pane.failed': '这个 shell 启动失败。',
        'pane.failedWith': '这个 shell 启动失败：{message}',
        'pane.retryScreen': '重试',
        'pane.history': '正在显示重启前最后的内容。要执行命令请新建终端。',
        'pane.historyClear': '清除',
        'pane.closeThis': '关闭这个分屏',
        'pane.missing': '这个 shell 已经不在了（宿主重启过）。',
        'pane.limit': '该会话已达终端数量上限（已退出的终端也计入），请先关闭一个分屏。',
        'pane.inputFull': '输入量超出终端缓冲，连接已断开。',
        'pane.noService': '这个分屏无法使用终端服务。',
        'pane.chunkFailed': '终端画面加载失败：{message}',
        'pane.takeControl': '接管输入',
        'pane.reconnect': '重新连接',
        'pane.newTerminal': '新建终端',
        'pane.waiting': '正在等待 shell…',
      },
    }

    // ── styles ─────────────────────────────────────────────────────────────

    const CSS = `
.twp-root{display:flex;flex:1 1 auto;flex-direction:column;align-self:stretch;box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.5}
.twp-bar{display:flex;align-items:center;gap:12px;flex:none;box-sizing:border-box;min-height:44px;padding:8px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
[data-platform='darwin'] .twp-bar{padding-top:calc(8px + var(--dsh-frame-top-clearance,0px))}
.twp-title{flex:none;max-width:34%;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.twp-tabs{display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.twp-tabs::-webkit-scrollbar{display:none}
.twp-tab{display:flex;align-items:center;gap:6px;flex:none;max-width:220px;padding:4px 6px 4px 9px;border:.5px solid transparent;border-radius:7px;color:var(--dsw-alias-label-secondary);cursor:default;user-select:none}
.twp-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.twp-tab-active{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary)}
.twp-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.twp-tabGlyph{display:flex;flex:none;opacity:.85}
.twp-tabTitle{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px}
.twp-tabInput{min-width:60px;max-width:140px;padding:0 3px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.twp-tabClose{display:flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);opacity:0;cursor:pointer}
.twp-tab:hover .twp-tabClose,.twp-tab-active .twp-tabClose,.twp-tab:focus-within .twp-tabClose{opacity:1}
.twp-tabClose:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.twp-actions{display:flex;align-items:center;gap:4px;flex:none}
.twp-iconButton{display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.twp-iconButton:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.twp-iconButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.twp-primaryButton{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.twp-primaryButton:hover{background:var(--dsw-alias-bg-layer-1)}
.twp-primaryButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.twp-surface{display:flex;flex:1;min-height:0;min-width:0;padding:6px}
.twp-split{display:flex;flex:1;min-height:0;min-width:0;gap:6px}
.twp-split-column{flex-direction:column}
.twp-splitCell{display:flex;flex:1 1 0;min-height:0;min-width:0}
.twp-gutter{flex:0 0 6px;border-radius:3px;background:transparent;cursor:col-resize;touch-action:none}
.twp-gutter:hover,.twp-gutter:active{background:var(--dsw-alias-state-business-primary);opacity:.45}
.twp-gutter-column{cursor:row-resize}
.twp-pane{display:flex;flex:1;flex-direction:column;box-sizing:border-box;min-width:0;min-height:0;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.twp-pane-active{border-color:var(--dsw-alias-state-business-primary)}
.twp-paneHead{display:flex;align-items:center;gap:4px;flex:none;padding:4px 6px 4px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.twp-paneTitle{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-primary);cursor:text}
.twp-titleInput{flex:1;min-width:0;padding:1px 4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.twp-paneSpacer{flex:1;min-width:4px}
.twp-paneMeta{flex:none;max-width:38%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:11px}
.twp-historyNote{display:flex;flex-wrap:wrap;align-items:center;gap:10px;flex:none;padding:5px 10px;font-size:12px;color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.twp-paneStatus{display:flex;flex-wrap:wrap;align-items:center;gap:10px;flex:none;padding:5px 10px;background:var(--dsw-alias-bg-module-platform);font-size:12px;color:var(--dsw-alias-label-secondary)}
.twp-statusText{min-width:0;overflow-wrap:anywhere}
.twp-linkButton{padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline}
.twp-screen{flex:1;min-height:0;min-width:0;overflow:hidden;padding:6px 8px}
.twp-screen .xterm{height:100%}
.twp-screen .xterm-viewport{background:transparent}
.twp-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px;text-align:center;color:var(--dsw-alias-label-secondary)}
.twp-emptyText{margin:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.twp-emptyHint{margin:0;font-size:12px;max-width:44ch}
`

    // ── plugin ─────────────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: LOCALES.en, zh: LOCALES.zh }), 'terminal-workspace: copy')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = PACKAGE
          tag.dataset.pluginCss = `${PACKAGE}/panel.css`
          tag.textContent = CSS
          document.head.append(tag)
          return () => { tag.remove() }
        }, 'terminal-workspace: styles')

        const face = createFace(ctx)
        ctx.effect(() => face.theme.start(), 'terminal-workspace: theme source')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ face }),
        }, TerminalWorkspacePanel)), 'terminal-workspace: panel')

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 0.5,
          locale: NS,
          label: () => t('entry'),
        }, TerminalWorkspaceIcon)), 'terminal-workspace: sidebar row')
      },
    }
  },
})
