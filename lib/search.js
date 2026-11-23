/**
 * 学习版 · 资料查询
 *
 * 面板里输入一句话或一个词，这边回两样东西：
 *   1. 原文：从资料库的经典原文里按关键词找出来的段落，附出处；
 *   2. 白话：把这批原文交给当前默认模型，逐段译成大白话。
 *
 * 检索是纯本地的（不联网、不花钱）；白话翻译要调一次模型，调不动就只回原文，
 * 由面板提示「白话没译出来」，绝不假装译过。
 *
 * 整段都包在 try/catch 里：这一路失败只等于查询页不好用，不影响主体启动。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fromThisMachine } from './guard.js'
import { findAcupoint, acupointInfo } from './acupoints.js'
import { decodeSample } from './kb-index.js'
import { MAX_FILE_BYTES } from './book-text.js'

/**
 * 查原文只扫这几个子目录里的 .txt / .md（含子目录）。
 * 与 auto-file 的五分类对齐：新书被挪进 经典/方药 后照样搜得到。
 * 医案绝不收——病历隐私，不进检索。
 */
export const CORPUS_DIRS = ['text', '名著', '经典注解', '经典', '方药']

/** 递归深度上限与文件总数上限：防止误把挂载点扫穿、把内存读爆。 */
const MAX_CORPUS_DEPTH = 6
const MAX_CORPUS_FILES = 2000

/**
 * 一段话短于这个长度就不算一段（多半是标题目录）；长于这个长度就切。
 * 经典条文往往很短：《伤寒论》第一条「太阳之为病，脉浮、头项强痛而恶寒。」只有 21 字，
 * 用 24 字当门槛会把整条丢掉——这是面板查不到经典首条的直接原因。
 */
const MIN_LEN = 4
const MAX_LEN = 900

/** 目录名去掉编号前缀和扩展名，留书名。 */
export function bookName(file) {
  return String(file)
    .replace(/\.(txt|md)$/i, '')
    .replace(/^\d+[-_．.]?\s*/, '')
    .trim()
}

/** 把文本压成「无空白、无标点」的形式，方便按字找。 */
export function squash(text) {
  return String(text || '').replace(/[\s　]/g, '')
}

/** 去掉 Markdown 标题记号与加粗记号，留人看的篇名。 */
function cleanHeading(line) {
  let t = String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
  // 定稿本用「第1篇　上古天真论篇第一」当篇名，前面的编号不进出处。
  t = t.replace(/^第\d+篇[　\s]*/, '')
  // 括注（「（二十四种）」）不是篇名的一部分。
  t = t.replace(/[（(][^）)]*[）)]/g, '')
  // 篇名后面常跟「合一十六法，方一十四首」这类统计，切掉它，别带进出处。
  t = t.replace(/[　\s]+(?=(合|方|并见|厥利))[\s\S]*$/, '')
  // 篇名为了排版拉开的空格（「辨 脉 法」）收掉。
  t = t.replace(/[　\s]+/g, '').replace(/[：:]$/, '')
  return t.trim()
}

/**
 * 篇名：Markdown 标题行；定稿本「第1篇　……」；或短行、不带句读，
 * 以「篇／论／法／例／第一……／脉证并治」收尾。
 * 「辨太阳病脉证并治上/中/下」结尾是上中下，也要认；「按此论」这种正文短句不能误认。
 */
function isHeading(line) {
  const raw = String(line || '').trim()
  if (!raw) return false
  if (/^#{1,6}\s+/.test(raw)) return true
  // 「第1篇　上古天真论篇第一」：编号本身就说明是篇名，后面不以「篇」收尾也认。
  if (/^第\d+篇[　\s]/.test(raw)) return true
  const t = cleanHeading(raw)
  if (!t || t.length < 2 || t.length > 40) return false
  if (/[。，；：！？]/.test(t)) return false
  if (/^第[一二三四五六七八九十百]+难$/.test(t)) return true
  if (/^卷[上中下]$/.test(t)) return true
  if (/^卷[一二三四五六七八九十百]+([·.].*)?$/.test(t)) return true
  if (/第[一二三四五六七八九十百]+$/.test(t)) return true
  return /(篇|论|法|例|脉证并治|病脉证治|证并治)(第[一二三四五六七八九十百]+)?(上|中|下)?$/.test(t)
}

/** 方名独占一行（「桂枝汤方」「一物瓜蒂汤方」），要跟下面的药物组成并成一段。 */
function isFormulaName(text) {
  const t = String(text || '').trim()
  return /^[一-龥（）()·]{1,12}(汤|散|丸|膏|丹|饮|煎)方$/.test(t)
}

/**
 * 把一个文件切成一段一段的原文，顺手记住它属于哪一篇。
 * @param {string} file 文件名
 * @param {string} raw 文件内容
 * @returns {{source: string, text: string}[]}
 */
export function splitPassages(file, raw) {
  const book = bookName(file)
  const lines = String(raw || '').split(/\r?\n/)
  const out = []
  let heading = ''
  let clauseNo = ''
  let buf = []
  let pendingFormula = ''
  const sourceOf = (no) => [book, heading && heading !== book ? heading : '', no ? '第' + no + '条' : '']
    .filter(Boolean)
    .join(' · ')
  const push = (text, no) => {
    if (text.length < MIN_LEN) return
    // 超长段（一整篇没断行）按句号切，免得一段几千字塞爆面板；没有句号就硬切。
    if (text.length <= MAX_LEN) {
      out.push({ source: sourceOf(no), text })
      return
    }
    const parts = text.split(/(?<=[。！？；])/)
    let piece = ''
    for (const part of parts) {
      if (piece.length + part.length > MAX_LEN && piece) {
        out.push({ source: sourceOf(no), text: piece })
        piece = ''
      }
      piece += part
    }
    if (piece.length > MAX_LEN) {
      // 整段没有句读，按长度硬切，别让 MAX_LEN 形同虚设。
      for (let i = 0; i < piece.length; i += MAX_LEN) {
        const chunk = piece.slice(i, i + MAX_LEN).trim()
        if (chunk.length >= MIN_LEN) out.push({ source: sourceOf(no), text: chunk })
      }
    } else if (piece.trim().length >= MIN_LEN) {
      out.push({ source: sourceOf(no), text: piece.trim() })
    }
  }
  const flush = () => {
    let text = buf.join('').trim()
    const no = clauseNo
    buf = []
    if (!text) return
    // 方名和药物组成之间常隔一个空行：先把方名存着，下一段并进来再一起入段。
    if (!pendingFormula && isFormulaName(text)) {
      pendingFormula = text
      return
    }
    if (pendingFormula) {
      if (isFormulaName(text)) {
        push(pendingFormula, no)
        pendingFormula = text
        return
      }
      text = pendingFormula + ' ' + text
      pendingFormula = ''
    }
    // 条号不在这里清：定稿本的方药块跟在条文后、隔一个空行，仍属上一条。
    push(text, no)
  }
  for (const line of lines) {
    // 定稿本夹着 U+E000–U+F8FF 私用区字符（脚注、排版标记），会破坏方名/篇名判断。
    const t = line.replace(/[\uE000-\uF8FF]/g, '').trim()
    if (!t) { flush(); continue }
    if (isHeading(t)) {
      flush()
      if (pendingFormula) { push(pendingFormula, clauseNo); pendingFormula = '' }
      heading = cleanHeading(t)
      clauseNo = ''
      continue
    }
    // 定稿本一条一段，条号写成「　　12．」；旧语料写成「**12．**」。两种都认。
    const numbered = /^(?:\*\*)?(\d+)[．.、](?:\*\*)?\s*/.exec(t)
    if (numbered) {
      flush()
      clauseNo = numbered[1]
      buf.push(t.slice(numbered[0].length).trim())
      continue
    }
    buf.push(t)
  }
  flush()
  if (pendingFormula) { push(pendingFormula, clauseNo); pendingFormula = '' }
  return out
}

/** 从句子里挑出搜索用的两字词组；中文按两字滑窗，够用又不容易漏。 */
export function grams(query) {
  const clean = squash(query).replace(/[，。！？、；：「」『』（）()《》〈〉·,.;:!?"'“”‘’\-—…]/g, '')
  if (!clean) return []
  const out = []
  if (clean.length <= 2) {
    out.push(clean)
    return out
  }
  for (let i = 0; i < clean.length - 1; i += 1) {
    const g = clean.slice(i, i + 2)
    if (!out.includes(g)) out.push(g)
  }
  // 整句也当一个长词组，命中整句的段落排最前。
  out.unshift(clean)
  return out
}

/** 一段原文命中多少个词组：整句命中给大分，两字词组各给一分。 */
export function scoreText(text, list) {
  if (!list.length) return 0
  let score = 0
  const phrase = list[0]
  if (phrase && text.indexOf(phrase) >= 0) score += 20 + phrase.length * 2
  for (let i = 0; i < list.length; i += 1) {
    const g = list[i]
    if (!g || g === phrase) continue
    let from = 0
    let hits = 0
    while (hits < 8) {
      const at = text.indexOf(g, from)
      if (at < 0) break
      hits += 1
      from = at + g.length
    }
    score += hits * 2
  }
  return score
}

/** 按句号、问号、感叹号切句，给「挑最贴题的一句」用。 */
function sentences(text) {
  return String(text || '').split(/(?<=[。！？；])/).filter((x) => x.trim() !== '')
}

/**
 * 在一段里挑出最贴题的一句，带上前一句做上下文，别把整段 900 字甩出去。
 * @returns {{text: string, score: number}}
 */
export function bestWindow(text, list) {
  const parts = sentences(text)
  if (parts.length <= 1) return { text: String(text || '').trim(), score: scoreText(text, list) }
  let bestAt = 0
  let bestScore = -1
  for (let i = 0; i < parts.length; i += 1) {
    const sc = scoreText(parts[i], list)
    if (sc > bestScore) { bestScore = sc; bestAt = i }
  }
  let out = parts[bestAt]
  if (out.length < 80 && parts[bestAt + 1]) out += parts[bestAt + 1]
  if (out.length < 40 && parts[bestAt - 1]) out = parts[bestAt - 1] + out
  return { text: out.trim(), score: bestScore }
}

/** 读到内存里的一套原文；资料库大时也只读一次。递归子目录，编码探测与索引同口径。 */
export async function loadCorpus(rootDir, options = {}) {
  const all = []
  const logger = options.logger
  const stats = { count: 0, capped: false, skipped: 0, firstError: '' }
  const seenDirs = new Set()
  if (!rootDir) return all
  try { seenDirs.add(await fs.realpath(rootDir)) } catch { /* 根目录本身读不到，下面会报 */ }

  const takeFile = async (full, name, knownStat) => {
    if (!/\.(txt|md)$/i.test(name)) return
    // 索引是插件自己生成的，不是原文；嵌套的 索引-xxx.md 也不收。
    if (/^(索引|index)([-_.].*)?\.md$/i.test(name)) return
    // README / 说明 / 目录 是使用说明，不是经典原文；早期版本会把它复制进 text/，不进检索。
    if (/^(README|readme|说明|目录|凡例)\.md$/i.test(name)) return
    if (stats.count >= MAX_CORPUS_FILES) {
      stats.capped = true
      return
    }
    try {
      const st = knownStat || await fs.stat(full)
      // 单文件上限沿用整本读取的 32MB：超大书只索引不动它。
      if (st.size > MAX_FILE_BYTES) {
        stats.skipped += 1
        return
      }
      const buf = await fs.readFile(full)
      const head = buf.length >= 2 ? buf.subarray(0, 2).toString('hex') : ''
      const raw = decodeSample(buf, head)
      stats.count += 1
      all.push(...splitPassages(name, raw))
    } catch (error) {
      stats.skipped += 1
      if (!stats.firstError) stats.firstError = String(error && error.message ? error.message : error)
    }
  }

  const walk = async (dir, depth) => {
    if (stats.capped || depth > MAX_CORPUS_DEPTH) return
    let real
    try { real = await fs.realpath(dir) } catch (error) {
      stats.skipped += 1
      if (!stats.firstError) stats.firstError = String(error && error.message ? error.message : error)
      return
    }
    // 链接/挂载点可能成环，用真实路径去重。
    if (seenDirs.has(real)) return
    seenDirs.add(real)
    let entries = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      stats.skipped += 1
      if (!stats.firstError) stats.firstError = String(error && error.message ? error.message : error)
      return
    }
    for (const entry of entries) {
      if (stats.capped) return
      const name = entry.name
      if (name.startsWith('.')) continue
      // 嵌套的医案目录同样不收，隐私口径不留死角。
      if (name === '医案') continue
      const full = path.join(dir, name)
      let st
      try {
        // 用 stat 而不是 Dirent：Windows 的 junction、符号链接目录在 Dirent 里不算目录。
        st = await fs.stat(full)
      } catch (error) {
        stats.skipped += 1
        if (!stats.firstError) stats.firstError = String(error && error.message ? error.message : error)
        continue
      }
      if (st.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (st.isFile()) await takeFile(full, name, st)
    }
  }

  // 库根目录的散书也收：用户常把还没归类的书直接放在根上。
  let rootEntries = []
  try {
    rootEntries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch (error) {
    logger?.warn?.('资料库读取失败：' + String(error && error.message ? error.message : error))
    return all
  }
  for (const entry of rootEntries) {
    if (stats.capped) break
    if (entry.name.startsWith('.') || entry.name === '医案') continue
    const full = path.join(rootDir, entry.name)
    let st
    try {
      st = await fs.stat(full)
    } catch (error) {
      stats.skipped += 1
      if (!stats.firstError) stats.firstError = String(error && error.message ? error.message : error)
      continue
    }
    if (st.isDirectory()) {
      // 只下钻五个分类目录；根下其它目录（备份、附件等）不扫。
      if (!CORPUS_DIRS.includes(entry.name)) continue
      await walk(full, 1)
      continue
    }
    if (st.isFile()) await takeFile(full, entry.name, st)
  }

  if (stats.capped) {
    logger?.warn?.(`资料库文件超过 ${MAX_CORPUS_FILES} 本，只读了前 ${MAX_CORPUS_FILES} 本；没进检索的书仍能在索引里看到。`)
  }
  if (stats.skipped) {
    logger?.warn?.(`资料库读取跳过 ${stats.skipped} 个文件或目录` + (stats.firstError ? `（首个原因：${stats.firstError}）` : '') + '。')
  }
  return all
}

/** 一顿乱输（空、纯符号）就别搜了。 */
export function usableQuery(query) {
  return squash(query).replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').length >= 2
}

/**
 * 在一套原文里按词找段落：先按整句命中挑出最贴题的那一句，
 * 再按「命中分 ÷ 长度」排，短的、密的排前面。
 * @param {{source: string, text: string}[]} corpus
 * @param {string} query
 * @param {number} limit
 */
export function findPassages(corpus, query, limit = 6) {
  if (!usableQuery(query)) return []
  const list = grams(query)
  const clean = squash(query)
  const scored = []
  for (const item of corpus) {
    const win = bestWindow(item.text, list)
    if (win.score <= 0) continue
    // 以查询词开头的原文（「桂枝汤方」「太阳之为病……」）优先，别让长串方名排到前面。
    const flat = squash(item.text)
    const exact = clean && (flat.startsWith(clean) || flat.startsWith(clean + '方'))
    const density = win.score / Math.sqrt(Math.max(12, win.text.length)) + (exact ? 8 : 0)
    scored.push({ source: item.source, text: win.text, rank: density })
  }
  scored.sort((a, b) => b.rank - a.rank)
  const out = []
  const seen = new Set()
  for (const hit of scored) {
    // 出处也进 key：两本书收同一条文时，两边的出处都要留下。
    const key = hit.source + '|' + squash(hit.text).slice(0, 40)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ source: hit.source, text: hit.text })
    if (out.length >= limit) break
  }
  return out
}

/** 本草类书名：查单味药时，只从这些书里找条目。 */
const HERB_BOOK = /本草/

// 定稿《神农本草经》把桂枝、桂心、肉桂都归在「牡桂」条下，正文没有「一名桂枝」。
const HERB_ALIASES = {
  桂枝: ['牡桂'],
  桂心: ['牡桂'],
  肉桂: ['牡桂'],
}

/** 把一段本草原文拆成「原文／性味／功效／产地」。 */
export function parseHerbText(text) {
  const t = String(text || '').trim()
  // 定稿本药名独占一行，下一行直接「味甘，平」，合并后是「丹沙味甘，平」；
  // 所以先在「味」前取药名，取不到再按标点/空白切。
  const nameFirst = /^([^\s　，。；：、（）()]{1,8})\s*味/.exec(t)
  const head = nameFirst
    ? nameFirst[1].trim()
    : (t.split(/[：:，,。；、\s　（(]/, 1)[0] || '').trim()
  const flavor = /味\s*([^，。；]{1,12})[，、]\s*(微温|微寒|温|热|寒|凉|平)/.exec(t)
  const effect = /(主|治)\s*([^。]{2,120})。/.exec(t)
  const origin = /生\s*([^。；，]{1,24})/.exec(t)
  const aliases = [...t.matchAll(/一名\s*([^。；，]{1,10})/g)].map((m) => m[1].trim())
  return {
    head: head.trim(),
    nature: flavor ? ('味' + flavor[1] + '，' + flavor[2]) : '',
    effect: effect ? (effect[2] + '。') : '',
    origin: origin ? origin[1].trim() : '',
    aliases,
    original: (flavor || effect ? t : ''),
  }
}

/**
 * 查单味药：在本草类书里找以这味药开头的条目（也认「一名某某」的别名）。
 * @param {{source: string, text: string}[]} corpus
 * @param {string} query
 * @param {number} limit
 */
export function findHerbEntries(corpus, query, limit = 4) {
  const name = squash(query)
  if (!/^[一-龥]{1,6}$/.test(name)) return []
  const wanted = [name].concat(HERB_ALIASES[name] || [])
  const out = []
  for (const item of corpus) {
    if (!HERB_BOOK.test(item.source)) continue
    const parsed = parseHerbText(item.text)
    if (!parsed.original) continue
    // 只认「药名开头、紧跟性味」的条目；整页讲义、方书里顺带提到药名的段落不算。
    if (!/^[一-龥]{1,8}$/.test(parsed.head)) continue
    if (!item.text.trim().startsWith(parsed.head)) continue
    const names = [parsed.head].concat(parsed.aliases)
    if (!names.some((one) => wanted.includes(one))) continue
    out.push({
      source: item.source,
      original: parsed.original,
      meta: {
        nature: parsed.nature,
        effect: parsed.effect,
        origin: parsed.origin,
        alias: parsed.aliases.filter((one) => one !== name).join('、'),
      },
    })
    if (out.length >= limit) break
  }
  return out
}

const PLAIN_SYSTEM = [
  '你是中医古籍的白话翻译。用户会给你若干段带编号的原文，',
  '请逐段译成现代汉语大白话：一句原文对一句白话，尽量照着原文说，不添加原文没有的内容。',
  '每段只用一行，格式是「【编号】白话」，编号与原文一致；不要译成文言，不要加解释、不要加标题。',
].join('')

/** 把检索到的原文逐段译成白话；模型不可用就返回 null。 */
export async function translate(ctx, passages, timeoutMs = 20000) {
  if (!passages.length) return null
  const pick = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : () => undefined
  const llm = pick('llm')
  const models = pick('agentDefaultModel')
  const select = models && typeof models.currentSelection === 'function' ? models.currentSelection() : null
  if (!llm || typeof llm.stream !== 'function' || !select || !select.provider || !select.model) return null
  const body = passages.map((p, i) => '【' + (i + 1) + '】' + p.text).join('\n\n')
  const message = {
    role: 'user',
    id: randomUUID(),
    source: { kind: 'user' },
    content: [{ type: 'text', text: body }],
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 20000))
  let text = ''
  try {
    const stream = llm.stream({
      provider: select.provider,
      model: select.model,
      system: PLAIN_SYSTEM,
      messages: [message],
      maxTokens: 1600,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
  const out = new Map()
  for (const line of text.split(/\r?\n/)) {
    const hit = /^\s*【\s*(\d+)\s*】\s*(.+)$/.exec(line)
    if (hit) out.set(Number(hit[1]), hit[2].trim())
  }
  if (out.size === 0) return null
  return passages.map((p, i) => out.get(i + 1) || '')
}

/**
 * 开一条只读查询通道给面板用：挂在 DSH 本机 Web 服务的固定路径上，浏览器直接 fetch。
 * @param {object} ctx 插件 context
 * @param {{rootDir: () => string, path?: string, log?: string}} options
 */
export async function mountSearchRoute(ctx, options) {
  const log = options.log || '[资料查询]'
  const routePath = options.path || '/dsh-tcm-xueli/search'
  let corpus = null
  let corpusAt = 0
  let corpusKey = ''

  const ensureCorpus = async () => {
    const root = options.rootDir ? options.rootDir() : ''
    if (!root) return []
    if (corpus && corpusKey === root && Date.now() - corpusAt < 60000) return corpus
    corpus = await loadCorpus(root, { logger: ctx.logger })
    corpusAt = Date.now()
    corpusKey = root
    return corpus
  }

  /** 查一次：先回原文，能译就带上白话。 */
  const runQuery = async (raw, rawLimit) => {
    const n = Math.max(1, Math.min(12, Number(rawLimit) || 6))
    const text = String(raw === undefined || raw === null ? '' : raw)
    if (!usableQuery(text)) {
      return { ok: false, reason: '请至少输入两个字，比如「便秘」「少阴病」「肝主疏泄」。', results: [] }
    }
    const all = await ensureCorpus()
    if (!all.length) {
      return { ok: false, reason: '资料库里没读到原文，先到设置页确认资料库路径。', results: [] }
    }
    /* 穴位：先把名字对上，能找到就把穴位图放在最前面，原文照样往下查。 */
    let pointRow = null
    try {
      const point = findAcupoint(text)
      if (point) pointRow = { acupoint: acupointInfo(point) }
    } catch (error) {
      ctx.logger?.warn?.('学理模式：穴位名没对上（不影响查询）：%o', error)
    }

    /* 单味药先查本草条目：原文、性味、功效、产地一次给全。 */
    const herbs = findHerbEntries(all, text, Math.min(n, 4))
    if (herbs.length) {
      const rows = herbs.map((one) => ({ ...one, plain: '' }))
      return { ok: true, reason: '', results: pointRow ? [pointRow, ...rows] : rows }
    }
    const hits = findPassages(all, text, n)
    if (!hits.length) {
      return {
        ok: true,
        reason: pointRow
          ? '原文里没找到这几个字，先把穴位图放这儿；换一味药、一个证名再试。'
          : '原文里没找到这几个字，换个说法或换一味药、一个证名试试。',
        results: pointRow ? [pointRow] : [],
      }
    }
    let plains = null
    try { plains = await translate(ctx, hits) } catch { plains = null }
    const results = hits.map((hit, i) => ({
      source: hit.source,
      original: hit.text,
      plain: plains ? plains[i] || '' : '',
    }))
    if (pointRow) results.unshift(pointRow)
    return {
      ok: true,
      reason: plains ? '' : '白话没译出来（模型这会儿没响应），先看原文。',
      results,
    }
  }

  let webServer = ctx.get ? ctx.get('webServer') : undefined
  /* Web 服务可能比本插件晚就位：最多等十秒，等不到就明说，不硬撑。 */
  for (let i = 0; i < 20 && (!webServer || typeof webServer.register !== 'function'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    webServer = ctx.get ? ctx.get('webServer') : undefined
  }
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('这台 DSH 没有 Web 服务，查不了')
  }

  const dispose = webServer.register({
    kind: 'exact',
    path: routePath,
    handler: async (req, res) => {
      const send = (code, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      // 只认真正的本机连接：判断统一收在门卫（lib/guard.js），三条通道共用一份。
      if (!fromThisMachine(req)) {
        send(403, { ok: false, reason: '只接受本机页面的查询。', results: [] })
        return
      }
      let url
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1')
      } catch {
        send(400, { ok: false, reason: '查询参数看不懂。', results: [] })
        return
      }
      try {
        const q = String(url.searchParams.get('q') || '').slice(0, 200)
        send(200, await runQuery(q, url.searchParams.get('n')))
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        ctx.logger?.warn?.(log + '查询出错：' + message)
        // 内部错误细节只进日志，不回显给前端（免得泄露路径等内部信息）。
        send(200, { ok: false, reason: '查询没跑通，请稍后再试；细节已记日志。', results: [] })
      }
    },
  })

  ctx.logger?.info?.(log + '查询通道已开：' + routePath)
  return () => {
    try { dispose?.() } catch (error) {
      ctx.logger?.warn?.(log + '关闭查询通道出错：' + String(error && error.message ? error.message : error))
    }
  }
}