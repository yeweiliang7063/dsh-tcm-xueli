/**
 * 中医 · 经方 · 会话归档
 *
 * 一个中医会话对应一份 Markdown，不再一条回答一个文件：
 * - 文件名用会话标题（例如「61岁高血压患者后脑勺疼.md」）；
 * - 正文保存整段会话里真人说的话和中医 · 经方的回答；
 * - 标题变化时自动改名，旧文件随之删除；
 * - 只记本插件预设（dsh-tcm-xueli）及旧版 tcm 别名的会话，普通编码会话不写。
 *
 * 任何异常都只返回 null 或记日志，绝不向上抛：归档失败不能影响会话。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { blotDosage } from './dosage-guard.js'
import { insideRoot } from './kb-root.js'
import { ownPreset } from './guard.js'
import { dshHome } from './purge.js'

/** 回答归档目录，和五类文件夹里的「医案」是同一个。 */
export const RECORD_DIR = '医案'
/** 本插件预设的 id；只有这个预设（及旧版 tcm 别名）的会话才归档。 */
export const DEFAULT_PRESET = 'dsh-tcm-xueli'
/** 文件名最多保留多少字符，避免超长标题把路径顶爆。 */
const MAX_TITLE = 80

/* ── 最近几局的题面与结论：跨重启也翻得到，开局前能直接看见上几局出过什么病 ── */

export const ROUNDS_FILE = '最近几局.jsonl'
const ROUNDS_KEEP = 60

/** 锚点摘要：底牌是 sha256 前 12 位。医生会话挂着文件工具，明文锚点落盘等于泄底；
 *  哈希只够主持人对账「这一局用的哪张底牌」，反推不出内容。空串原样，已是摘要的原样。 */
function anchorDigest(anchor) {
  const text = String(anchor ?? '')
  if (!text) return ''
  if (/^[0-9a-f]{12}$/.test(text)) return text
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/* ── 跨进程文件锁：整文件读-改-写临界区一次只让一个进程进 ── */

/** 锁超过这么久视为持有者崩溃残留，可破锁重试（正常临界区是毫秒级的小文件读写，远不到这数）。 */
const LOCK_STALE_MS = 10000
/** 拿不到锁时的重试间隔与次数：最多忙等约 1 秒，绝不把写操作永久卡死。 */
const LOCK_WAIT_MS = 20
const LOCK_TRIES = 50

/** 用 mkdir 的原子性当跨进程互斥量（同一文件系统上两个进程不会同时 mkdir 成功）。
 *  拿到锁就跑同步临界区 fn，跑完释放；锁是崩溃残留就破掉重试；等超时则记日志后 best-effort 直写
 *  （宁可承担一次并发风险，也不把归档永久 hang 住）。进程内另有 roundsQueue 串行，正常无竞争。
 *  @returns fn 的返回值。 */
function withFileLock(lockDir, fn, logger) {
  let acquired = false
  for (let i = 0; i < LOCK_TRIES; i += 1) {
    try {
      mkdirSync(lockDir)
      acquired = true
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true })
          continue
        }
      } catch (statError) { /* 锁刚被释放或读不到，下一轮再试 */ }
      // 短暂忙等（Atomics.wait 不烧 CPU）；只在真有跨进程竞争时才会走到这里。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS)
    }
  }
  if (!acquired) {
    try { logger?.warn?.('[学理模式] 资料库写入锁等待超时，本次直接写（可能与他进程并发）：' + lockDir) } catch (inner) { /* 日志坏了也不卡写 */ }
  }
  try {
    return fn()
  } finally {
    if (acquired) {
      try { rmSync(lockDir, { recursive: true, force: true }) } catch (inner) { /* 释放失败留给 stale 机制兜底 */ }
    }
  }
}

/** 读最近几局；库没设、文件没有、读坏了，一律回空数组。
 *  旧文件里若有明文锚点，读时就换成摘要并择机重写一次（迁移），失败记日志不静默。 */
export function readRecentRounds(kb, logger) {
  try {
    if (!kb || !existsSync(kb)) return []
    const dir = join(kb, RECORD_DIR)
    if (!insideRoot(kb, dir)) return []
    const file = join(dir, ROUNDS_FILE)
    if (!insideRoot(kb, file) || !existsSync(file)) return []
    const rows = readFileSync(file, 'utf8')
      .split(SPLIT_NEWLINE)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch (error) { return null } })
      .filter((row) => row && typeof row === 'object')
      .slice(-ROUNDS_KEEP)
    let migrated = false
    for (const row of rows) {
      const raw = String(row.anchor ?? '')
      const digest = anchorDigest(raw)
      if (raw && digest !== raw) {
        row.anchor = digest
        migrated = true
      }
    }
    if (migrated) {
      try {
        writeFileSync(file, rows.map((one) => JSON.stringify(one)).join(NEWLINE) + NEWLINE, 'utf8')
      } catch (error) {
        try { logger?.warn?.('[学理模式] 最近几局的明文锚点迁移重写失败：' + (error?.message || error)) } catch (inner) { /* 日志也坏了就不拖累读 */ }
      }
    }
    return rows
  } catch (error) {
    return []
  }
}

/** 进程内串行队列：整文件读-改-写必须一次一个，防止并发两笔互相覆盖丢行。
 *  跨进程另由 withFileLock（mkdir 互斥量）兜底：两个进程同时写同一文件也不会互相覆盖。 */
let roundsQueue = Promise.resolve()

/** 记一局（同一局号覆盖）；写不进去返回 false 并记日志，绝不静默，也绝不影响这一局。
 *  锚点只落摘要（见 anchorDigest）。返回 Promise<boolean>，调用方要查结果。 */
export function saveRecentRound(kb, row, logger) {
  const task = roundsQueue.then(() => saveRecentRoundNow(kb, row, logger))
  roundsQueue = task.catch(() => {})
  return task
}

function saveRecentRoundNow(kb, row, logger) {
  try {
    if (!kb || !row || typeof row !== 'object') return false
    const id = String(row.id ?? '').trim()
    if (!id) return false
    const dir = join(kb, RECORD_DIR)
    if (!insideRoot(kb, dir)) return false
    mkdirSync(dir, { recursive: true })
    const file = join(dir, ROUNDS_FILE)
    if (!insideRoot(kb, file)) return false
    return withFileLock(file + '.lock', () => {
      const rows = readRecentRounds(kb, logger).filter((one) => String(one.id ?? '').trim() !== id)
      rows.push({
        id,
        createdAt: Number(row.createdAt) || 0,
        level: String(row.level ?? ''),
        direction: String(row.direction ?? ''),
        caseSummary: String(row.caseSummary ?? ''),
        verdict: String(row.verdict ?? ''),
        failLine: String(row.failLine ?? ''),
        prescribe: String(row.prescribe ?? ''),
        anchor: anchorDigest(row.anchor),
        finishedAt: Number(row.finishedAt) || 0,
      })
      writeFileSync(file, rows.slice(-ROUNDS_KEEP).map((one) => JSON.stringify(one)).join(NEWLINE) + NEWLINE, 'utf8')
      return true
    }, logger)
  } catch (error) {
    try { logger?.warn?.('[学理模式] 最近几局落盘失败（重启后可能翻不到）：' + (error?.message || error)) } catch (inner) { /* 日志也坏了就只剩返回值 */ }
    return false
  }
}

/* ── 打赏局数：每判完十局，在裁判点评末尾摆一次收款码 ── */

export const GIFT_FILE = '打赏局数.json'

/** 读已判完的局数与上次摆过打赏的那一档；读不到、读坏了都按 0 算。 */
export function readRoundProgress(kb) {
  try {
    if (!kb || !existsSync(kb)) return { total: 0, giftAt: 0 }
    const dir = join(kb, RECORD_DIR)
    if (!insideRoot(kb, dir)) return { total: 0, giftAt: 0 }
    const file = join(dir, GIFT_FILE)
    if (!insideRoot(kb, file) || !existsSync(file)) return { total: 0, giftAt: 0 }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return {
      total: Math.max(0, Math.floor(Number(data?.total) || 0)),
      giftAt: Math.max(0, Math.floor(Number(data?.giftAt) || 0)),
    }
  } catch (error) {
    return { total: 0, giftAt: 0 }
  }
}

/** 局数与上次摆打赏的档位一起写；写不进去只影响计数，绝不影响这一局。 */
export function saveRoundProgress(kb, progress) {
  try {
    if (!kb || !progress || typeof progress !== 'object') return false
    const dir = join(kb, RECORD_DIR)
    if (!insideRoot(kb, dir)) return false
    mkdirSync(dir, { recursive: true })
    const file = join(dir, GIFT_FILE)
    if (!insideRoot(kb, file)) return false
    writeFileSync(file, JSON.stringify({
      total: Math.max(0, Math.floor(Number(progress.total) || 0)),
      giftAt: Math.max(0, Math.floor(Number(progress.giftAt) || 0)),
    }) + NEWLINE, 'utf8')
    return true
  } catch (error) {
    return false
  }
}

/* ── 思考档位存根：开局压低前记下原档，重启/热重载后靠它把档位还回去 ── */

export const GEAR_FILE = '思考档位.json'
/** 最多留 50 条：正常用完即清，剩下的都是意外残留，不该越攒越多。 */
const GEAR_KEEP = 50

/** 读存根；库没设、文件没有、读坏了，一律回空对象。 */
export function readGearState(kb) {
  try {
    if (!kb || !existsSync(kb)) return {}
    const dir = join(kb, RECORD_DIR)
    if (!insideRoot(kb, dir)) return {}
    const file = join(dir, GEAR_FILE)
    if (!insideRoot(kb, file) || !existsSync(file)) return {}
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out = {}
    for (const key of Object.keys(data)) {
      const entry = data[key]
      if (!key || !entry || typeof entry !== 'object') continue
      out[key] = {
        restore: typeof entry.restore === 'string' ? entry.restore : '',
        at: Number(entry.at) || 0,
      }
    }
    return out
  } catch (error) {
    return {}
  }
}

/** 整份写回；按时间只留最近 GEAR_KEEP 条。写不进只影响重启后的还原。 */
function writeGearState(kb, state) {
  try {
    if (!kb) return false
    const dir = join(kb, RECORD_DIR)
    if (!insideRoot(kb, dir)) return false
    mkdirSync(dir, { recursive: true })
    const file = join(dir, GEAR_FILE)
    if (!insideRoot(kb, file)) return false
    const keys = Object.keys(state)
      .sort((a, b) => (Number(state[b]?.at) || 0) - (Number(state[a]?.at) || 0))
      .slice(0, GEAR_KEEP)
    const out = {}
    for (const key of keys) out[key] = state[key]
    writeFileSync(file, JSON.stringify(out) + NEWLINE, 'utf8')
    return true
  } catch (error) {
    return false
  }
}

/** 调低之前记一条：这一局原来的档位是什么（没有档位就是空串）。 */
export function saveGearEntry(kb, sessionId, restore) {
  const key = String(sessionId || '').trim()
  if (!key) return false
  const state = readGearState(kb)
  state[key] = { restore: typeof restore === 'string' ? restore : '', at: Date.now() }
  return writeGearState(kb, state)
}

/** 档位还回去了就清掉这一条；本来没有这条就当没事。 */
export function dropGearEntry(kb, sessionId) {
  const key = String(sessionId || '').trim()
  if (!key) return false
  const state = readGearState(kb)
  if (!Object.prototype.hasOwnProperty.call(state, key)) return false
  delete state[key]
  return writeGearState(kb, state)
}

/* ── 最近几局用过的锚点：跨重启也记得住，避免一开机就撞上天的病 ── */

/** 旧文件名：曾放在「医案」目录里，医生会话的文件工具读得到＝泄底。现在只用于迁移。 */
export const ANCHOR_FILE = '最近抽过的锚点.jsonl'
/** 新家在插件私有目录（DSH 家目录下），不进资料库，医生读不到。 */
export const ANCHOR_PRIVATE_DIR = 'dsh-tcm-xueli'
export const ANCHOR_PRIVATE_FILE = 'anchors.jsonl'
/** 只留最近 40 条，够避开最近八局，也不至于越攒越多。 */
const ANCHOR_KEEP = 40
/** 兼容 Windows 的换行：拆行用这个，别在正则里写反斜杠。 */
const NEWLINE = String.fromCharCode(10)
const SPLIT_NEWLINE = new RegExp('\r?\n')

function anchorPrivateFile() {
  return join(dshHome(), ANCHOR_PRIVATE_DIR, ANCHOR_PRIVATE_FILE)
}

function readAnchorLines(file) {
  try {
    if (!file || !existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split(SPLIT_NEWLINE)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    return []
  }
}

/** 旧文件迁移：内容读走合并进私有目录后删掉旧文件（插件自产缓存，不是用户手稿）。
 *  先写新文件再删旧的：写失败时旧文件还在，下次再迁，不丢数据；失败记日志不静默。 */
function migrateAnchorFile(kb, logger) {
  try {
    if (!kb || !existsSync(kb)) return
    const dir = join(kb, RECORD_DIR)
    if (!insideRoot(kb, dir)) return
    const oldFile = join(dir, ANCHOR_FILE)
    if (!insideRoot(kb, oldFile) || !existsSync(oldFile)) return
    const merged = []
    for (const line of [...readAnchorLines(oldFile), ...readAnchorLines(anchorPrivateFile())]) {
      const at = merged.indexOf(line)
      if (at >= 0) merged.splice(at, 1)
      merged.push(line)
    }
    mkdirSync(join(dshHome(), ANCHOR_PRIVATE_DIR), { recursive: true })
    writeFileSync(anchorPrivateFile(), merged.slice(-ANCHOR_KEEP).join(NEWLINE) + NEWLINE, 'utf8')
    unlinkSync(oldFile)
  } catch (error) {
    try { logger?.warn?.('[学理模式] 锚点历史迁移到私有目录失败：' + (error?.message || error)) } catch (inner) { /* 日志也坏了就不拖累读 */ }
  }
}

/** 读最近抽过的锚点：从私有目录读；库里还有旧文件就读走合并后删掉（一次性迁移）。 */
export function readSeenAnchors(kb, logger) {
  try {
    migrateAnchorFile(kb, logger)
    return readAnchorLines(anchorPrivateFile()).slice(-ANCHOR_KEEP)
  } catch (error) {
    return []
  }
}

/** 记一条抽过的锚点（私有目录）；写不进去返回 false 并记日志，绝不静默，也绝不影响这一局。 */
export function appendSeenAnchor(kb, anchor, logger) {
  try {
    const one = String(anchor ?? '').trim()
    if (!one) return false
    migrateAnchorFile(kb, logger)
    mkdirSync(join(dshHome(), ANCHOR_PRIVATE_DIR), { recursive: true })
    return withFileLock(anchorPrivateFile() + '.lock', () => {
      const old = readAnchorLines(anchorPrivateFile())
      old.push(one)
      writeFileSync(anchorPrivateFile(), old.slice(-ANCHOR_KEEP).join(NEWLINE) + NEWLINE, 'utf8')
      return true
    }, logger)
  } catch (error) {
    try { logger?.warn?.('[学理模式] 锚点历史落盘失败（下一局避重可能不准）：' + (error?.message || error)) } catch (inner) { /* 日志也坏了就只剩返回值 */ }
    return false
  }
}

/** 从 content 块数组里取可见正文；reasoning / 工具调用块不要。 */
export function answerText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
    .trim()
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function readableOf(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  return [
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  ].join(' ')
}

/** 会话 id 取前 8 个字母数字，用作无标题时的兜底名。 */
function shortSession(sessionId) {
  const raw = String(sessionId ?? '')
    .replace(/^session-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
  return raw.slice(0, 8) || 'anon'
}

/**
 * 把会话标题变成安全的 Windows 文件名。
 * 去掉路径分隔符、冒号、问号等非法字符，空标题退回「中医会话-会话号」。
 */
/**
 * Windows 上这些名字是设备名，叫 CON.md 也一样打不开（不认扩展名）。
 * 标题正好撞上就加个前缀，别让整份医案写不进去。
 */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function safeTitle(title, sessionId) {
  let value = typeof title === 'string' ? title.trim() : ''
  value = value
    .replace(/[\\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim()
  if (!value) value = `中医会话-${shortSession(sessionId)}`
  if (DEVICE_NAME.test(value)) value = `中医会话-${value}`
  const trimmed = value.slice(0, MAX_TITLE).trim()
  if (DEVICE_NAME.test(trimmed)) return `中医会话-${shortSession(sessionId)}`
  return trimmed || `中医会话-${shortSession(sessionId)}`
}

/* ── 闭麦回合标记：模拟问诊里主持人替病人想底牌的回合，正文不能进医生可读的归档 ── */

/** sessionId → 闭麦回合号集合。sim-think 在闭麦发生时打标；归档监听注册在 thinker 之前，
 *  收到 assistant/message 时就得查得到标记，所以打标要在 user/message 阶段做。 */
const mutedTurns = new Map()
const MUTED_SESSIONS_KEEP = 200
const MUTED_TURNS_KEEP = 400

/** 把某会话的一个回合标成闭麦：该回合的助手正文不进归档。 */
export function noteMutedTurn(sessionId, turn) {
  const key = String(sessionId ?? '')
  const nth = Number(turn)
  if (!key || !Number.isFinite(nth)) return
  let set = mutedTurns.get(key)
  if (!set) {
    if (mutedTurns.size >= MUTED_SESSIONS_KEEP) {
      const oldest = mutedTurns.keys().next().value
      mutedTurns.delete(oldest)
    }
    set = new Set()
    mutedTurns.set(key, set)
  }
  if (set.size >= MUTED_TURNS_KEEP) {
    const oldest = set.values().next().value
    set.delete(oldest)
  }
  set.add(nth)
}

/** 收局/关局时清掉这一会话的闭麦标记。 */
export function clearMutedTurns(sessionId) {
  mutedTurns.delete(String(sessionId ?? ''))
}

/**
 * 从会话事件里提取真人发言和助手正文，按发生顺序返回。
 * 只收 `source.kind === 'user'` 的 user/message；系统提示、AGENTS.md、运行时上下文、
 * 审批策略等注入消息都不算用户说的话。
 * mutedTurnSet：闭麦回合号集合（可选），这些回合的助手正文整条跳过。
 */
export function conversationFromEvents(events, mutedTurnSet) {
  const list = []
  const muted = mutedTurnSet instanceof Set ? mutedTurnSet : null
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = askText(event.data?.content)
      if (text) list.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      // 闭麦回合（模拟问诊里主持人在想底牌/替病人开口）：正文可能带底牌明文，
      // 医生会话的文件工具读得到归档，整回合跳过；病人转述与判卷回合照常。
      if (muted && muted.has(Number(event.data?.turn))) continue
      // 落库前再挖一遍：出口只改发出去的那份，会话里存的仍是原始回答，
      // 不在这里挖，存档和医案里还会留着克数、毫升数。
      const text = blotDosage(answerText(event.data?.message?.content))
      if (text) list.push({ role: 'assistant', text })
    }
  }
  return list
}

/**
 * 用户提问的正文：文字照收；图片记成「[图片]」、附件记成文件名，
 * 免得「发一张截图配一句话」的提问在医案里整条消失。
 */
function askText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') {
      const text = part.text.trim()
      if (text) parts.push(text)
    } else if (part.type === 'image') {
      parts.push('[图片]')
    } else if (part.type === 'file' || part.type === 'attachment') {
      const name = part.name || part.attachment?.name || part.file?.name
      parts.push(name ? `[附件：${name}]` : '[附件]')
    }
  }
  return parts.join('\n').trim()
}

function renderSession({ title, sessionId, preset, createdAt, updatedAt, conversation }) {
  const body = conversation
    .map((message) => {
      const who = message.role === 'user' ? '用户' : '中医 · 经方'
      return `### ${who}\n\n${message.text}`
    })
    .join('\n\n')

  return [
    '---',
    `标题: ${JSON.stringify(title)}`,
    `会话: ${JSON.stringify(String(sessionId ?? ''))}`,
    `预设: ${JSON.stringify(String(preset ?? DEFAULT_PRESET))}`,
    `创建: "${readableOf(createdAt)}"`,
    `更新: "${readableOf(updatedAt)}"`,
    '来源: "中医 · 经方自动记录"',
    '---',
    '',
    `# ${title}`,
    '',
    '## 对话',
    '',
    body,
    '',
  ].join('\n')
}

/** 两个路径是否指向同一份文件：先 realpath 解析（化解大小写/斜杠/链接写法差异）；
 *  文件已不在、解析失败时退回词法比较（Windows 不分大小写）。 */
function samePath(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (!left || !right) return false
  let ra = left
  let rb = right
  try { ra = realpathSync(left) } catch (error) { /* 文件没了就退回词法 */ }
  try { rb = realpathSync(right) } catch (error) { /* 同上 */ }
  if (ra === rb) return true
  const na = resolve(ra)
  const nb = resolve(rb)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

function fileBelongsToSession(file, sessionId) {
  try {
    const text = readFileSync(file, 'utf8')
    // 只认文件头 frontmatter 里的会话字段：正文里引用到别的会话号，
    // 不能当成那一局的文件（否则会误删、误覆盖）。
    if (!text.startsWith('---')) return false
    const end = text.indexOf('\n---', 3)
    if (end < 0) return false
    const want = `会话: ${JSON.stringify(String(sessionId ?? ''))}`
    return text.slice(0, end).split(SPLIT_NEWLINE).some((line) => line.trim() === want)
  } catch (error) {
    return false
  }
}

/**
 * 把整段会话写进 <kb>/医案/<会话标题>.md。
 *
 * 同名文件如果属于别的会话，自动加「 (2)」「 (3)」；如果是本会话上一版文件，
 * 直接覆盖。标题变化时写新文件并删掉本会话的旧文件，保证一个会话只留一份。
 *
 * @param {object} entry
 * @param {string} entry.kb 资料库根目录
 * @param {string} entry.sessionId 会话 id
 * @param {string} [entry.preset] 预设 id
 * @param {string} [entry.title] 会话标题
 * @param {any[]} entry.events 会话事件（user/message、assistant/message 等）
 * @param {Date} [entry.now] 更新时间
 * @param {string} [entry.previousFile] 本会话上一次写入的文件
 * @returns {string|null} 写入的文件路径；失败返回 null
 */
export function recordSession({
  kb,
  sessionId,
  preset = DEFAULT_PRESET,
  title,
  events,
  now = new Date(),
  previousFile,
} = {}) {
  try {
    if (!kb || !existsSync(kb)) return null
    const conversation = conversationFromEvents(events, mutedTurns.get(String(sessionId ?? '')))
    if (conversation.length === 0) return null

    const dir = join(kb, RECORD_DIR)
    // 库根锁定：医案目录必须还在设置指定的库根里，跑到外面就不归档。
    if (!insideRoot(kb, dir)) return null
    mkdirSync(dir, { recursive: true })

    const updatedAt = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
    const first = (Array.isArray(events) ? events : []).find((event) => Number.isFinite(event?.time))
    const createdAt = first ? new Date(first.time) : updatedAt
    const displayTitle = typeof title === 'string' && title.trim() ? title.trim() : safeTitle('', sessionId)
    const base = safeTitle(displayTitle, sessionId)

    let target = join(dir, `${base}.md`)
    if (existsSync(target) && !samePath(target, previousFile) && !fileBelongsToSession(target, sessionId)) {
      let found = false
      for (let index = 2; index <= 100; index += 1) {
        const candidate = join(dir, `${base} (${index}).md`)
        if (!existsSync(candidate) || fileBelongsToSession(candidate, sessionId)) {
          target = candidate
          found = true
          break
        }
      }
      // 同名文件已经被别的会话占满 100 个：宁可换个带时间的文件名，
      // 也不能回过手来把别人的医案覆盖掉。
      if (!found) {
        const stamp = updatedAt.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
        target = join(dir, `${base} (${stamp}).md`)
      }
    }

    // 重启后内存里的上一份路径丢了：扫一遍同会话的旧文件，
    // 标题已生成时把旧的兜底名或旧标题文件一并清掉，保证一个会话只留一份。
    const stale = []
    if (!previousFile) {
      try {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.md')) continue
          const candidate = join(dir, name)
          if (!samePath(candidate, target) && fileBelongsToSession(candidate, sessionId)) stale.push(candidate)
        }
      } catch (error) {
        // 目录暂时读不到就不清理，正文仍然照写。
      }
    }

    const content = renderSession({
      title: displayTitle,
      sessionId,
      preset,
      createdAt,
      updatedAt,
      conversation,
    })
    if (!insideRoot(kb, target)) return null
    writeFileSync(target, content, 'utf8')

    const oldFiles = new Set(stale)
    if (previousFile && !samePath(previousFile, target)) oldFiles.add(previousFile)
    for (const file of oldFiles) {
      if (samePath(file, target)) continue
      // 删前复查库根：换过库根时 previousFile 指向旧库，旧库的归档不能顺手删掉。
      if (!insideRoot(kb, file)) continue
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch (error) {
        // 旧文件删不掉不影响新文件；下次还会再试。
      }
    }
    return target
  } catch (error) {
    return null
  }
}

/**
 * 生成 `session/event` 监听器。
 *
 * 监听真人发言和助手回答，每次都按会话快照重写同一份 Markdown：
 * 不会漏掉前面的对话，也不会因为一条回答重复写多个文件。
 *
 * DSH 的 `session.header.agentPreset` 只是“创建时的预设”，会话在空白窗口里换过预设后
 * header 不会变；当前预设要去读 `agentPreset` 投影。`currentPreset` 由宿主注入，
 * 读不到时退回 header，兼容旧版 DSH。
 *
 * @param {object} options
 * @param {() => string} options.getKb 返回当前资料库路径
 * @param {string} [options.preset] 预设 id
 * @param {(session: any) => string | null | undefined} [options.currentPreset] 读取当前预设
 * @param {(session: any) => string | null | undefined} [options.getTitle] 读取会话标题
 * @param {{info?: Function, warn?: Function}} [options.logger] 插件日志
 * @returns {(session: any, event: any) => void}
 */
export function createSessionRecorder({ getKb, preset = DEFAULT_PRESET, currentPreset, getTitle, logger } = {}) {
  const files = new Map()

  return function onSessionEvent(session, event) {
    try {
      if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'session/title')) return

      // 门卫：只归档本插件预设（及旧版别名）的会话，普通编码会话不写。
      if (!ownPreset(session, { currentPreset, preset })) return

      const sessionId = session?.id
      if (!sessionId) return

      const kb = typeof getKb === 'function' ? getKb() : ''
      if (!kb || !existsSync(kb)) return

      let title
      if (typeof getTitle === 'function') {
        try {
          title = getTitle(session)
        } catch (error) {
          title = undefined
        }
      }
      // 标题生成可能晚于最后一条回答；session/title 事件本身带着最终标题，
      // 收到它时直接改名，不依赖标题服务是否已经折叠了当前事件。
      if (event.type === 'session/title' && typeof event.data?.title === 'string') {
        title = event.data.title
      }

      let events = []
      try {
        events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
      } catch (error) {
        events = []
      }
      if (!Array.isArray(events) || events.length === 0) events = [event]
      else if (!events.some((item) => item && item.seq === event.seq && item.type === event.type)) {
        events = [...events, event]
      }

      const saved = recordSession({
        kb,
        sessionId,
        preset,
        title,
        events,
        now: Number.isFinite(event.time) ? new Date(event.time) : new Date(),
        previousFile: files.get(sessionId),
      })

      if (saved) {
        files.set(sessionId, saved)
        logger?.info?.('中医 · 经方：会话已存入医案：%s', saved)
      } else {
        logger?.warn?.('中医 · 经方：会话归档未写入（资料库可能不可写）：%s', kb)
      }
    } catch (error) {
      logger?.warn?.('中医 · 经方：会话归档失败（不影响会话）：%o', error)
    }
  }
}
