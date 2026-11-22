import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * 把一局会话从磁盘上真正删掉。
 *
 * DSH 自己没有「删会话」的接口，只有归档（归档＝只读，东西还在）。
 * 这里照 @linxin666/dsh-session-archive 的做法自己动手：
 *   1. 先归档，让宿主认为这一局已经结束（归档是幂等的，已经归档也不报错）；
 *   2. 把它从工作区的会话名册里摘掉；
 *   3. 删掉 `~/.dsh/sessions/<工作区>/<会话号>/` 这个目录；
 *   4. 顺手把投影缓存里的标题条目去掉，免得列表里留个空壳。
 *
 * 顺序是「先摘名册、后删文件」：中途断电最坏是「文件还在但列表里看不见」，
 * 重开一次再点一次就清干净，不会留下半个会话。
 */

const SESSION_ID = /^[A-Za-z0-9._-]{1,120}$/

/** DSH 的家目录：桌面版默认在用户目录下的 .dsh。 */
export function dshHome() {
  const raw = String(process.env.DSH_HOME || '').trim()
  return raw ? raw : join(homedir(), '.dsh')
}

/** 会话目录可能在任意工作区子目录下，按「工作区目录/session-id」找。 */
export function findSessionDirs(id, home = dshHome()) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name, id)
    try {
      if (!statSync(dir).isDirectory()) continue
      // 只删真正落在 sessions 里面的目录，符号链接指向外面的一律不碰。
      const realRoot = realpathSync(root)
      const real = realpathSync(dir)
      if (!isInside(realRoot, real)) continue
      found.push(dir)
    } catch {
      /* 没有就是没有 */
    }
  }
  return found
}

function isInside(root, target) {
  const a = resolve(root)
  const b = resolve(target)
  return b === a || b.startsWith(a + sep)
}

function removeProjcache(home, id) {
  let removed = false
  // 现在的 DSH：一局一个文件，落在 session_projcache/sessions/<会话号>.json
  const perSession = join(home, 'storages', 'session_projcache', 'sessions', id + '.json')
  try {
    if (existsSync(perSession)) {
      rmSync(perSession, { force: true })
      removed = true
    }
  } catch {
    /* 删不掉就留着，不影响会话已经不在了 */
  }
  // 老版本是一个大文件，顺手也按老结构清一遍。
  const legacy = join(home, 'storages', 'session_projcache.json')
  if (!existsSync(legacy)) return removed
  try {
    const doc = JSON.parse(readFileSync(legacy, 'utf8'))
    const sessions = doc && doc.tables && doc.tables.sessions
    if (!sessions || !sessions[id]) return removed
    delete sessions[id]
    writeFileSync(legacy, JSON.stringify(doc), 'utf8')
    return true
  } catch {
    return removed
  }
}

/**
 * 真正删掉一局。
 * @param {object} ctx 插件 context（要用 workspaceRegistry）
 * @param {string} sessionId 会话号
 * @returns {Promise<{ok: boolean, removed: string[], reason?: string}>}
 */
export async function purgeSession(ctx, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id || !SESSION_ID.test(id)) return { ok: false, removed: [], reason: '会话号看不懂' }
  const home = dshHome()
  const removed = []

  let registry
  try {
    registry = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  } catch {
    registry = undefined
  }

  // 1. 归档：宿主只肯删「已经结束」的局；已经归档的再调一次也不会出错。
  try {
    if (registry && typeof registry.archiveSession === 'function') {
      await registry.archiveSession(id, { stopActivity: true })
    }
  } catch {
    /* 已经归档/已经没了都算正常 */
  }

  // 2. 从工作区名册里摘掉这一行，列表里立刻看不见。
  try {
    if (registry && typeof registry.list === 'function') {
      for (const entity of registry.list() || []) {
        if (!entity) continue
        const ids = Array.isArray(entity.sessionIds) ? entity.sessionIds : []
        if (!ids.includes(id)) continue
        // 先用宿主公开的摘会话接口；老版本实体上没有这个接口，再退回实体自带的 mutate。
        if (typeof entity.detachSession === 'function') {
          await entity.detachSession(id)
        } else if (typeof entity.mutate === 'function') {
          await entity.mutate((record) => ({
            ...record,
            sessionIds: (Array.isArray(record.sessionIds) ? record.sessionIds : []).filter((one) => one !== id),
          }))
        }
      }
    }
  } catch {
    /* 名册摘不掉时，后面删目录照样能让它不再出现 */
  }

  // 3. 删目录。
  for (const dir of findSessionDirs(id, home)) {
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      /* 单个目录删不掉不影响另一个工作区里的同名目录 */
    }
  }

  // 4. 投影缓存里的标题条目。
  removeProjcache(home, id)

  return { ok: removed.length > 0, removed }
}

/**
 * 待清名单：点评完被锁上的局，正常关面板时会当场删掉；万一页面是被直接关掉的
 * （卸载钩子来不及跑），下一回 DSH 起来再照这份名单清一次。落在 DSH 家目录，
 * 不依赖资料库设没设。
 */
const LEDGER_FILE = 'dsh-tcm-xueli-pending.json'
const LEDGER_KEEP = 80

function ledgerPath(home) {
  return join(home, LEDGER_FILE)
}

export function readPending(home = dshHome()) {
  try {
    const file = ledgerPath(home)
    if (!existsSync(file)) return []
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(raw?.ids) ? raw.ids.filter((one) => SESSION_ID.test(String(one))) : []
  } catch {
    return []
  }
}

function writePending(ids, home) {
  try {
    writeFileSync(ledgerPath(home), JSON.stringify({ ids: ids.slice(-LEDGER_KEEP) }), 'utf8')
    return true
  } catch {
    return false
  }
}

export function addPending(id, home = dshHome()) {
  if (!SESSION_ID.test(String(id || ''))) return false
  const ids = readPending(home).filter((one) => one !== id)
  ids.push(id)
  return writePending(ids, home)
}

export function dropPending(id, home = dshHome()) {
  const ids = readPending(home)
  const next = ids.filter((one) => one !== id)
  if (next.length === ids.length) return false
  return writePending(next, home)
}

/** 把名单上的局逐个删掉；删不掉的留着下一回再试。返回删掉几个。 */
export async function sweepPending(ctx, home = dshHome()) {
  const ids = readPending(home)
  if (ids.length === 0) return 0
  let done = 0
  for (const id of ids) {
    try {
      await purgeSession(ctx, id)
      dropPending(id, home)
      done += 1
    } catch {
      /* 留着下次 */
    }
  }
  return done
}
