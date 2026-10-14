/**
 * dsh-session-delete — Host half.
 *
 * Gives the DSH web UI a way to delete a session, which the harness itself does
 * not expose: `SessionPersistence` has create/open/flush/stat/list and no delete,
 * `WorkspaceRegistry` has archive/unarchive and no delete. A session log is a
 * plain directory of files, so deletion is a filesystem operation this plugin
 * owns.
 *
 * Three pieces:
 *
 *   1. Path construction. The JSONL backend derives a session's directory from
 *      `config.root`, the header's `cwd`, and the session id, through two
 *      injective transforms that are private to that package. They are
 *      reproduced here verbatim (see PATHS below) because the backend exposes
 *      the resolved root but not the derived path. `sessionPersistence.list()`
 *      hands back a header per session, and that header carries the `cwd`, so
 *      the directory is computed rather than searched for — no scan of the
 *      sessions root is ever needed.
 *
 *   2. `SessionDeleteService`. Lists what can be deleted, and deletes one:
 *      refuse a live session, flush, locate, verify the directory contents
 *      against a whitelist, remove, then clean the durable registries that
 *      would otherwise keep dangling ids.
 *
 *   3. Two routes on `ctx.webServer`, behind the host's own trust fence and an
 *      additional loopback requirement on the write, because deletion is
 *      irreversible and a session token must not be enough to destroy history
 *      from another machine on the LAN.
 *
 * `inject` is deliberately empty. Cordis holds a fiber PENDING while a service
 * it names is absent, which would keep this plugin inactive on a composition
 * that omits one of these peers. The dependencies are waited for through
 * `ctx.inject(...)` instead, so a missing peer degrades one feature rather than
 * the whole plugin.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-session-delete'

/** Nothing. See the module comment. */
export const inject = []

/** Where the browser half asks for. */
const API_PREFIX = '/api/session-delete'

/** Largest accepted session id. DSH mints `session-<uuid>` or a bare uuid. */
const ID_MAX = 128

/** A session id the harness itself could have minted. */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/

/**
 * One canonical generation artifact of either physical encoding, or the
 * kernel write lock. Anything else in a session directory is a reason to
 * refuse the delete rather than to remove it.
 */
const ALLOWED_ENTRY_RE = /^session\.v\d+\.jsonl(\.zstd)?$|^session\.lock$/

/** Longest a request body may be; the delete payload is one short id. */
const MAX_BODY_BYTES = 4096

/**
 * How long to let the `workspace/session-stop` providers land before the
 * directory is removed. Long enough for a cancel to propagate, short enough
 * that a wedged provider costs a pause rather than the delete.
 */
const STOP_SETTLE_MS = 250

// ─── PATHS ───────────────────────────────────────────────────────────────────
//
// Reproduced from `@deepseek-ai/dsh-session-persistence-jsonl`, which keeps
// them module-private. A session id is an unvalidated branded string, so
// `encodeSegment` must neutralize `../`, absolute paths, NUL, and separators
// before it becomes a path segment; `projectKey` turns a cwd into one
// human-readable directory name. Both are injective over the inputs the
// harness produces, and the second is intentionally lossy, so it is only ever
// used to *locate* a directory — never to validate one.
//
// Keep these in step with the backend. If a harness upgrade changes either
// transform, deletion starts reporting `session/absent` for sessions that
// exist, which is the safe direction to fail in.

/**
 * Encode one string as a single safe path segment, injectively over all JS
 * (UTF-16) strings including lone surrogates. Safe code units stay literal;
 * every other unit, `~` included, becomes `~XXXX`. `.` and `..` are special
 * cased so an otherwise-safe whole segment cannot traverse.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the readable directory key for a project path. Filesystem separators
 * and drive separators become `-`; unsafe code units use the same `~XXXX`
 * escape as session ids. The key is bounded for filesystem component limits.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * The directory one session owns under the backend's root. A pure function of
 * its three inputs — no filesystem access, so a cwd that has since been
 * deleted or moved still resolves to the same name it did when written.
 * @param root - the backend's configured sessions root.
 * @param cwd - the session's `cwd`; `undefined` selects `_no-cwd`.
 * @param id - the session id.
 * @returns the session directory path.
 */
function sessionDirOf(root, cwd, id) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return path.join(root, project, encodeSegment(id))
}

/**
 * Resolve the harness home the same way the host does: `$DSH_HOME` when set
 * and non-blank, otherwise `~/.dsh` under the OS home.
 * @returns the absolute harness home path.
 */
function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim())
  const home = process.env.USERPROFILE || process.env.HOME
  if (typeof home === 'string' && home !== '') return path.join(path.resolve(home), '.dsh')
  return path.resolve('.dsh')
}

// ─── errors ──────────────────────────────────────────────────────────────────

/** A delete the service refused, carrying the stable code the browser shows. */
class DeleteRefused extends Error {
  /**
   * @param code - stable machine-readable reason.
   * @param message - human-readable detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'DeleteRefused'
    this.code = code
  }
}

// ─── service ─────────────────────────────────────────────────────────────────

/**
 * Lists deletable sessions and deletes one. Every dependency is read through
 * `ctx.get`, so a composition missing one degrades a field rather than
 * throwing.
 */
class SessionDeleteService {
  /**
   * @param ctx - plugin context.
   * @param config - resolved plugin configuration; `home` overrides the
   *   harness home used to locate the durable registries.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.homeOverride = typeof config?.home === 'string' && config.home.trim() !== '' ? path.resolve(config.home.trim()) : undefined
    /** Session id -> the snapshot the last `list()` saw. */
    this.known = new Map()
    /**
     * Ids deleted during this host generation whose logs are gone from disk.
     *
     * A session the user chatted with keeps its Agent/Session object resident
     * in `ctx.sessions`, and the session-query corpus merge lists live sessions
     * unconditionally — so after our delete, a browser refresh rebuilds the
     * client baseline from that in-memory ghost, and the row reappears
     * (ungrouped, with full text). There is no public API to dispose a
     * session owned by another fiber, so we record what we deleted and let
     * the browser half reap the ghosts. Tombstones live exactly as long as
     * the ghosts do: both die at host restart.
     */
    this.tombstones = new Set()
  }

  /** Record one deleted id (and its subtree) for the browser-side reaper. */
  tombstone(...ids) {
    for (const id of ids) this.tombstones.add(id)
  }

  /** The JSONL backend, or undefined when the composition has none. */
  get persistence() {
    try {
      return this.ctx.get('sessionPersistence') ?? undefined
    } catch {
      return undefined
    }
  }

  /** The live session store, or undefined when absent. */
  get sessions() {
    try {
      return this.ctx.get('sessions') ?? undefined
    } catch {
      return undefined
    }
  }

  /** The session-query engine, used only for descendant counts. */
  get query() {
    try {
      return this.ctx.get('sessionQuery') ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * The durable workspace registry, or undefined when not composed.
   *
   * Must go through `ctx.get`, not a property access: property resolution
   * throws for a fiber that never declared the service in its inject list,
   * which silently pushed every cleanup onto the file-rewrite fallback.
   */
  get registry() {
    try {
      return this.ctx.get('workspaceRegistry') ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * The backend's sessions root. Read off the instance because the backend
   * publishes the resolved root as a plain field and derives every artifact
   * path from it; a composition without a readable one falls back to the
   * default home.
   * @returns the absolute sessions root.
   */
  root() {
    // A configured home is an explicit "everything lives here" and must steer
    // the sessions root too, or registry cleanup and log removal would point
    // at different trees in a relocated or sandboxed install.
    if (typeof this.homeOverride === 'string' && this.homeOverride.length > 0) {
      return path.join(path.resolve(this.homeOverride), 'sessions')
    }
    const backend = this.persistence
    const configured = backend?.root
    if (typeof configured === 'string' && configured.length > 0) return path.resolve(configured)
    return path.join(resolveHome(), 'sessions')
  }

  /**
   * Everything that can be deleted, newest first. Each entry carries the
   * facts the confirmation dialog shows, so the browser makes no second call
   * to describe one session.
   * @returns the deletable session list.
   */
  async list() {
    const persistence = this.persistence
    if (persistence === undefined) throw new DeleteRefused('unavailable', 'session persistence is not mounted')

    const live = new Set()
    const sessions = this.sessions
    if (sessions !== undefined) {
      try {
        for (const session of sessions.list()) live.add(String(session.id))
      } catch { /* the store is optional; absence just means nothing is live */ }
    }

    const snapshots = await persistence.list()
    const entries = []
    this.known = new Map()

    for (const snapshot of snapshots) {
      const header = snapshot.header
      const id = String(header.id)
      this.known.set(id, snapshot)
      entries.push({
        sessionId: id,
        title: await this.titleOf(id),
        createdAt: header.createdAt,
        cwd: header.cwd ?? null,
        parentSession: header.parentSession === undefined ? null : String(header.parentSession),
        delegationDepth: header.delegationDepth ?? 0,
        origin: header.origin ?? null,
        sizeBytes: snapshot.sizeBytes ?? 0,
        live: live.has(id),
        descendantCount: await this.descendantCountOf(id),
      })
    }

    entries.sort((left, right) => right.createdAt - left.createdAt)
    return entries
  }

  /**
   * The best display name available for one session. The query engine folds
   * titles from the log; a session without one keeps its id.
   * @param id - session id.
   * @returns the title, or the id itself.
   */
  async titleOf(id) {
    const query = this.query
    if (query === undefined) return id
    try {
      const snapshot = await query.readTitleSnapshot(id)
      const title = snapshot?.title?.title
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : id
    } catch {
      return id
    }
  }

  /**
   * How many descendants one session has, counting the whole subtree.
   * @param id - session id.
   * @returns the descendant count, or 0 when it cannot be determined.
   */
  async descendantCountOf(id) {
    const query = this.query
    if (query === undefined) return 0
    try {
      const trace = await query.traceSession(id)
      let count = 0
      const walk = (nodes) => {
        for (const node of nodes) {
          count += 1
          walk(node.descendants)
        }
      }
      walk(trace.descendants)
      return count
    } catch {
      return 0
    }
  }

  /**
   * Delete one session durably, and by default its whole descendant subtree.
   *
   * The order matters. Every provider is asked to stop the session's work
   * first, because removing a directory under an active writer tears the log.
   * The flush barrier then makes sure a session that only *looks* cold has
   * nothing buffered. Only then are the target directories located and
   * validated — all of them, before any is removed — and finally deleted.
   * Registry cleanup and announcement run last and never fail the delete: the
   * logs are already gone, and a dangling id costs one blank row, not data.
   * @param sessionId - the session to delete.
   * @param options - `cascade` (default true) also deletes every descendant.
   * @returns what happened, including how much was freed.
   */
  async delete(sessionId, options = {}) {
    const cascade = options.cascade !== false
    const id = String(sessionId)
    if (!ID_RE.test(id) || id.length > ID_MAX) {
      throw new DeleteRefused('invalid-id', `not a valid session id: ${JSON.stringify(id)}`)
    }

    const persistence = this.persistence
    if (persistence === undefined) throw new DeleteRefused('unavailable', 'session persistence is not mounted')

    // 1. Ask every provider to stop this session's running work, the same
    //    waterfall archiving uses. Nothing may be mid-write when the directory
    //    goes, and a session the user merely has open is retained for reading,
    //    which is not by itself a reason to refuse. A provider failure is
    //    logged by the registry and never blocks the delete.
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId: id })
    } catch { /* the delete is the user's explicit intent; a stop failure must not veto it */ }

    // 2. Give the stops a moment to land before touching bytes. Bounded, and
    //    never fatal: an unresponsive provider costs the wait, not the delete.
    await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS))

    // 3. Durability barrier: nothing buffered, everything on disk.
    try {
      await persistence.flush()
    } catch { /* a flush failure is not by itself a reason to refuse; the whitelist check below still guards the bytes */ }

    // 4. Locate the directory from the header's own cwd. No scan.
    const snapshot = this.known.get(id) ?? await persistence.stat(id)
    if (snapshot === undefined) {
      // Nothing on disk. Registry cleanup still runs: an archived id whose log
      // is already gone would otherwise linger as a blank row. This is also
      // the reaper's path: a resurrected ghost row re-deleted lands here, and
      // the announcement below drops it again.
      const cleaned = await this.cleanRegistries(id)
      this.tombstone(id)
      this.publishRemoval(id)
      return { deleted: false, absent: true, freedBytes: 0, registryCleaned: cleaned }
    }

    const root = this.root()
    const dir = sessionDirOf(root, snapshot.header.cwd, id)
    await this.assertInsideRoot(root, dir, id)

    // The whole subtree goes: see descendantIds for why leaving children is a
    // dead end rather than a choice. `cascade: false` is the escape hatch for a
    // caller that really wants only this one session.
    const subtree = cascade ? await this.descendantIds(id) : []

    // Phase 1 — resolve and validate EVERY directory before anything is
    // removed. A half-deleted lineage (parent gone, one child refused) is worse
    // than none gone: the orphans become unreachable immediately. So a single
    // refusal anywhere aborts the whole request and touches nothing.
    const targets = []
    for (const memberId of [id, ...subtree]) {
      const member = memberId === id ? snapshot : (this.known.get(memberId) ?? await persistence.stat(memberId))
      if (member === undefined) continue // already absent; nothing to validate
      const memberDir = sessionDirOf(root, member.header.cwd, memberId)
      await this.assertInsideRoot(root, memberDir, memberId)
      let present = true
      try {
        await fs.promises.stat(memberDir)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new DeleteRefused('io', `failed to read the session directory: ${String(error?.message ?? error)}`)
        }
        present = false
      }
      if (!present) continue
      // A refusal here names the offending session, because with a subtree the
      // user otherwise has no way to tell which member tripped it.
      try {
        await this.assertDeletable(memberDir)
      } catch (error) {
        if (error instanceof DeleteRefused) {
          throw new DeleteRefused(error.code, `subtree member ${JSON.stringify(memberId)}: ${error.message}`)
        }
        throw error
      }
      targets.push({ id: memberId, dir: memberDir })
    }

    if (targets.length === 0) {
      const cleaned = await this.cleanRegistries(id)
      for (const memberId of subtree) await this.cleanRegistries(memberId)
      this.tombstone(id, ...subtree)
      this.publishRemoval(id)
      for (const memberId of subtree) this.publishRemoval(memberId)
      this.known.delete(id)
      return {
        deleted: false, absent: true, freedBytes: 0, registryCleaned: cleaned,
        descendants: { requested: subtree.length, deleted: 0, ids: subtree },
      }
    }

    // Phase 2 — remove everything now that the whole set is known-good.
    let freedBytes = 0
    const removedIds = []
    for (const target of targets) {
      try {
        freedBytes += await this.directorySize(target.dir)
        await fs.promises.rm(target.dir, { recursive: true, force: true })
        removedIds.push(target.id)
      } catch (error) {
        if (error instanceof DeleteRefused) throw error
        const code = error?.code
        if (code === 'ENOENT') continue // vanished between validate and remove
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ETXTBSY') {
          throw new DeleteRefused('session/in-use', `subtree member ${JSON.stringify(target.id)}: this session is still held open by a writer; close it and try again`)
        }
        throw new DeleteRefused('io', `failed to remove the session directory: ${String(error?.message ?? error)}`)
      }
    }

    const removed = removedIds.includes(id)
    const descendantRemoved = removedIds.filter((memberId) => memberId !== id)

    // Registries and announcement for every member that actually went.
    let cleaned = true
    this.tombstone(...[id, ...subtree])
    for (const memberId of removedIds) {
      if ((await this.cleanRegistries(memberId)) === false) cleaned = false
      this.known.delete(memberId)
      this.publishRemoval(memberId)
    }
    // Members with no directory still need their dangling registry entries gone.
    if (removed === false && (await this.cleanRegistries(id)) === false) cleaned = false
    for (const memberId of subtree) {
      if (removedIds.includes(memberId)) continue
      await this.cleanRegistries(memberId)
      this.publishRemoval(memberId)
    }
    this.known.delete(id)

    return {
      deleted: removed, absent: !removed, freedBytes, registryCleaned: cleaned,
      descendants: { requested: subtree.length, deleted: descendantRemoved.length, ids: descendantRemoved },
    }
  }

  /**
   * Every session id in one session's descendant subtree, nearest first.
   *
   * A subagent child is a first-class session with its own log directory, and
   * the sidebar never renders one (`origin === 'subagent'` rows are hidden), so
   * a parent deleted alone leaves children that are unreachable from the UI and
   * permanent on disk. Deletion therefore carries its subtree.
   *
   * The trace engine is preferred; it already recurses to arbitrary depth over
   * the whole logical corpus. When the query service is absent the same tree is
   * rebuilt from the `parentSession` links in the persistence listing already
   * in memory. Neither path touches the filesystem — still no scan of the
   * sessions root.
   * @param id - the root of the subtree.
   * @returns descendant ids excluding `id` itself, deduplicated.
   */
  async descendantIds(id) {
    const query = this.query
    if (query !== undefined) {
      try {
        const trace = await query.traceSession(id)
        const found = []
        const seen = new Set([id])
        const walk = (nodes) => {
          for (const node of nodes) {
            const childId = String(node.session.header.id)
            if (seen.has(childId)) continue // defensive belt: cycles cannot recurse forever
            seen.add(childId)
            found.push(childId)
            walk(node.descendants)
          }
        }
        walk(trace.descendants ?? [])
        return found
      } catch { /* fall through to the header walk */ }
    }

    const persistence = this.persistence
    if (persistence === undefined) return []
    let snapshots
    try {
      snapshots = await persistence.list()
    } catch {
      return []
    }
    const childrenByParent = new Map()
    for (const snapshot of snapshots) {
      const parent = snapshot.header?.parentSession
      if (parent === undefined) continue
      const bucket = childrenByParent.get(String(parent)) ?? []
      bucket.push(String(snapshot.header.id))
      childrenByParent.set(String(parent), bucket)
    }
    const found = []
    const seen = new Set([id])
    const queue = [...(childrenByParent.get(id) ?? [])]
    while (queue.length > 0) {
      const childId = String(queue.shift())
      if (seen.has(childId)) continue
      seen.add(childId)
      found.push(childId)
      for (const grandchild of childrenByParent.get(childId) ?? []) queue.push(grandchild)
    }
    return found
  }

  /** Refuse a target that escapes the sessions root. */
  async assertInsideRoot(root, dir, id) {
    const resolvedRoot = path.resolve(root)
    const resolvedDir = path.resolve(dir)
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
      throw new DeleteRefused('path-escape', 'refusing to delete outside the sessions root')
    }
    if (path.basename(resolvedDir) !== encodeSegment(id)) {
      throw new DeleteRefused('path-escape', 'refusing to delete a directory that is not this session')
    }
  }

  /**
   * Refuse a directory holding anything but a session artifact or its write
   * lock. A user file in there is not the plugin's to destroy, and silently
   * removing it would be worse than refusing.
   * @param dir - the session directory.
   */
  async assertDeletable(dir) {
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    const unexpected = entries.filter((entry) => !entry.isFile() || !ALLOWED_ENTRY_RE.test(entry.name))
    if (unexpected.length > 0) {
      const names = unexpected.map((entry) => entry.name).join(', ')
      throw new DeleteRefused('unexpected-contents', `the session directory holds files this plugin will not delete: ${names}`)
    }
  }

  /** Total byte size of every file under one directory. */
  async directorySize(dir) {
    let total = 0
    const walk = async (current) => {
      let entries
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        try {
          total += (await fs.promises.stat(full)).size
        } catch { /* vanished mid-walk; the size is a report, not a fact to guard */ }
      }
    }
    await walk(dir)
    return total
  }

  /**
   * Announce the removal over DSH's own channel.
   *
   * `session/disposed` is what normally emits `api-session/removed`, but a
   * session the UI still retains never disposes at delete time — the browser
   * would keep rendering the row until some later reconnect rebuilt its
   * baseline from disk. Re-emitting the same event closes that gap: the
   * `api-remotes` forwarding loop picks it up, the client records a `remove`
   * mutation, and the row drops immediately. A second emission when the session
   * eventually does dispose is an idempotent no-op there.
   * @param sessionId - the session whose row must go.
   */
  publishRemoval(sessionId) {
    // Property access and call both inside the guard: `ctx.emit` is a mixed-in
    // accessor, and a composition without the event bus must not fail a delete
    // that has already removed the bytes.
    try {
      this.ctx?.emit?.('api-session/removed', sessionId)
    } catch { /* no listeners composed; the next baseline still reconciles */ }
  }

  /**
   * Drop one session id from every durable structure that could keep it: the
   * workspace registry's global archive and pin sets, each workspace's
   * session account, and the projection cache's per-session document.
   *
   * The registry's own mutation surface is preferred because it keeps the
   * in-memory cache, the durable table, and the attached browser's follow
   * stream in agreement. The file-rewrite fallback exists for a composition
   * without a registry (or a `home` override pointing at another harness home)
   * and rewrites the document atomically (temp + rename) so a crash mid-write
   * cannot truncate it. A failure here is reported, never thrown: the log is
   * already gone, and a dangling id costs one blank row that the next boot's
   * bootstrap reconciles anyway.
   * @param sessionId - the session id to forget.
   * @returns whether every cleanup step succeeded.
   */
  async cleanRegistries(sessionId) {
    let ok = true
    const home = this.homeOverride ?? resolveHome()

    // Prefer the registry's own mutation surface. Its unarchive and unpin entry
    // points document that an id whose session is already gone still resolves,
    // so this is exactly their supported case. Skipped when a `home` override
    // is set, because the composed registry then belongs to a different harness
    // home than the one being cleaned.
    if (this.homeOverride === undefined) {
      const registry = this.registry
      if (registry !== undefined) {
        try {
          const archived = registry.archivedSessionIds
          if (Array.isArray(archived) && archived.includes(sessionId)) await registry.unarchiveSession(sessionId)
          const pinned = registry.pinnedSessionIds
          if (Array.isArray(pinned) && pinned.includes(sessionId)) await registry.unpinSession(sessionId)
          for (const workspace of registry.list() ?? []) {
            try { await workspace.detachSession(sessionId) } catch { /* not accounted here */ }
          }
        } catch (error) {
          this.ctx.logger?.warn?.(`dsh-session-delete: registry cleanup failed: ${String(error?.message ?? error)}`)
          ok = false
        }
        await this.cleanProjectionCache(home, sessionId)
        return ok
      }
    }

    const registryPath = path.join(home, 'storages', 'workspace.json')
    try {
      const raw = await fs.promises.readFile(registryPath, 'utf8')
      const document = JSON.parse(raw)
      let changed = false

      const global = document?.global
      if (global !== undefined && global !== null) {
        for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
          const list = global[key]
          if (Array.isArray(list)) {
            const next = list.filter((value) => value !== sessionId)
            if (next.length !== list.length) {
              global[key] = next
              changed = true
            }
          }
        }
      }

      const workspaces = document?.tables?.workspaces
      if (workspaces !== undefined && workspaces !== null && typeof workspaces === 'object') {
        for (const record of Object.values(workspaces)) {
          const list = record?.sessionIds
          if (!Array.isArray(list)) continue
          const next = list.filter((value) => value !== sessionId)
          if (next.length !== list.length) {
            record.sessionIds = next
            changed = true
          }
        }
      }

      if (changed) {
        // Keep one backup of the previous document beside it. The registry is
        // small, the write is rare, and a mistake here costs the user their
        // whole workspace layout — so the undo has to be cheap to reach.
        const backup = `${registryPath}.bak`
        try {
          await fs.promises.copyFile(registryPath, backup)
        } catch { /* nothing to back up, or the backup already exists; either way the write below is still atomic */ }

        const temporary = `${registryPath}.${process.pid}.tmp`
        await fs.promises.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
        await fs.promises.rename(temporary, registryPath)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.ctx.logger?.warn?.(`dsh-session-delete: workspace registry cleanup failed: ${String(error?.message ?? error)}`)
        ok = false
      }
    }

    await this.cleanProjectionCache(home, sessionId)
    return ok
  }

  /**
   * Drop one session's projection-cache document. Derived data: a missing or
   * stale document only costs a longer replay, so this is best-effort and
   * silent.
   * @param home - the harness home holding the storages tree.
   * @param sessionId - the session whose cached projection goes.
   * @returns whether the document was removed (or was already absent).
   */
  async cleanProjectionCache(home, sessionId) {
    try {
      await fs.promises.rm(path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), { force: true })
      return true
    } catch { return false }
  }
}

// ─── routes ──────────────────────────────────────────────────────────────────

/** Read one bounded request body as UTF-8. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

/** Loopback authority: localhost, *.localhost, 127.0.0.0/8, ::1. */
function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (parts === null) return false
  if (Number(parts[1]) !== 127) return false
  return parts.slice(2).every((part) => Number(part) <= 255)
}

/**
 * Whether one request may proceed. The host's own fence is authoritative for
 * Host/Origin and browser authentication; this adds the loopback requirement
 * for the write, because a deletion cannot be undone and a Web session token
 * must not be enough to destroy history from another machine.
 * @param ctx - plugin context.
 * @param req - the incoming request.
 * @param method - the request method.
 * @returns the rejecting status, or undefined when the request may proceed.
 */
function rejectionFor(ctx, req, method) {
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    connection = undefined
  }

  let hostAuthority = ''
  try {
    hostAuthority = new URL(`http://${String(req.headers?.host ?? '')}`).host
  } catch {
    return 403
  }
  const loopback = isLoopbackHostname(new URL(`http://${hostAuthority}`).hostname)

  // The host fence is consulted first for non-loopback authorities, because it
  // alone knows what `--trusted-host` declared.
  if (typeof connection?.requestRejection === 'function') {
    let code
    try {
      code = connection.requestRejection(req)
    } catch {
      return 403
    }
    if (code !== undefined && code !== null && code !== false) {
      return typeof code === 'number' ? code : 403
    }
  } else if (!loopback) {
    return 403
  }

  if (method !== 'GET' && method !== 'HEAD' && !loopback) {
    return 403
  }
  return undefined
}

/**
 * Mount the two routes. Runs inside `ctx.inject(['webServer', ...])`, so the
 * service is present by construction; the effect keeps the registration owned
 * by the fiber.
 * @param ctx - plugin context.
 * @param service - the delete service.
 * @param server - the web server, resolved by the caller from the scoped ctx.
 */
function mountRoutes(ctx, service, server) {
  const guard = async (req, res, method, handler) => {
    const rejection = rejectionFor(ctx, req, method)
    if (rejection !== undefined) {
      json(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      const refused = error instanceof DeleteRefused ? error : null
      json(res, refused?.code === 'unavailable' ? 503 : 400, {
        ok: false,
        code: refused?.code ?? 'internal',
        error: String(error?.message ?? error),
      })
    }
  }

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${API_PREFIX}/sessions`,
    handler: (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      void guard(req, res, method, async (_req, response) => {
        const entries = await service.list()
        json(response, 200, { ok: true, sessions: entries, tombstones: [...service.tombstones] })
      })
    },
  }), 'dsh-session-delete: sessions route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${API_PREFIX}/delete`,
    handler: (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method !== 'POST' && method !== 'PUT') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      void guard(req, res, method, async (request, response) => {
        let payload
        try {
          payload = JSON.parse(await readBody(request, MAX_BODY_BYTES) || '{}')
        } catch {
          json(response, 400, { ok: false, code: 'bad-body', error: 'request body is not valid JSON' })
          return
        }
        const sessionId = payload?.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          json(response, 400, { ok: false, code: 'bad-body', error: 'sessionId is required' })
          return
        }
        const result = await service.delete(sessionId, { cascade: payload?.cascade !== false })
        json(response, 200, { ok: true, ...result })
      })
    },
  }), 'dsh-session-delete: delete route')
}

/**
 * Host plugin body.
 *
 * The route fiber waits for the services it names through a nested
 * `ctx.inject`, so a composition without a web server or without session
 * persistence simply has no delete surface instead of an inactive plugin.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration. The optional `home` key
 *   points the durable-registry cleanup at another harness home, which is what
 *   a test or a relocated installation uses.
 */
export function apply(ctx, config) {
  void config
  const service = new SessionDeleteService(ctx, config)

  ctx.inject(['webServer', 'connection', 'sessionPersistence'], (scoped) => {
    // Cordis exposes injected services as properties on the scoped context;
    // `get` is read as well so a context that only answers lookups still works.
    const server = scoped?.webServer ?? (typeof scoped?.get === 'function' ? scoped.get('webServer') : undefined)
    if (typeof server?.register !== 'function') {
      scoped?.logger?.warn?.('dsh-session-delete: no web server available; the delete routes are not mounted')
      return
    }
    mountRoutes(scoped, service, server)
  })

  ctx.effect(() => () => {
    service.known.clear()
  }, 'dsh-session-delete: teardown')
}
