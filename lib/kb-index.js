/**
 * 中医知识库索引生成器
 *
 * 按资料库根目录的实际文件，生成 `索引.md`：先分「经典 / 经典注解 / 名著 /
 * 医案 / 方药 / 其他」，每类一张「文件 | 体积」表，末尾给目录结构。
 * 归类先看目录名（放进这五个同名文件夹即按文件夹归类），再看书名关键词。
 * 纯 Node 实现，只读目录、只写 索引.md，不碰其它文件；异常交给调用方兜底。
 */
import { readdirSync, statSync, fstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { join, extname, dirname, basename } from 'node:path'
import { normalizeRoot } from './platform.js'
import { childOf, insideRoot } from './kb-root.js'
import { classifyBook } from './book-classify.js'

export { normalizeRoot }

export const INDEX_FILE = '索引.md'
export const MARKER = '本文件由「中医 · 经方」插件按目录自动生成'

/** 参与索引的扩展名；其它（图片、压缩包等）忽略。 */
const TEXT_EXTS = new Set(['.md', '.txt', '.doc', '.docx', '.pdf', '.epub'])

/** 五个大类，也是「按文件夹归类」时认的文件夹名；顺序即索引里的展示顺序。 */
export const CATEGORY_TITLES = ['经典', '经典注解', '名著', '医案', '方药']

/**
 * 在资料库根目录建好五个分类文件夹。
 *
 * 只建空文件夹，不移动、不改名任何书；某个文件夹建失败就跳过，
 * 下次启动或轮询时还会再试，不影响其它文件夹和主体启动。
 * @param {string} rootDir 资料库根目录（已确认存在）
 * @param {object} [logger] 可选日志器；建失败时 warn，不抛
 * @returns {number} 本次新建的文件夹数；没有日志通道且有失败时返回 -1，
 *   如实告诉上层「有文件夹没建成」（调用方 made>0 的判断不会误报已建立）。
 */
export function ensureCategoryDirs(rootDir, logger) {
  if (!rootDir || !existsSync(rootDir)) return 0
  const canLog = logger && typeof logger.warn === 'function'
  let created = 0
  let failed = 0
  for (const title of CATEGORY_TITLES) {
    const dir = join(rootDir, title)
    if (existsSync(dir)) continue
    try {
      mkdirSync(dir, { recursive: true })
      created += 1
    } catch (error) {
      // 单个文件夹失败不影响其它；下次启动或轮询再试。
      failed += 1
      if (canLog) logger.warn('中医 · 经方：分类文件夹 %s 建立失败（下次再试）：%o', dir, error)
    }
  }
  if (failed > 0 && !canLog) return -1
  return created
}

/**
 * 归类规则：先看目录名（放进这五个同名文件夹即按文件夹归类），再看书名。
 * 书名判定直接复用 book-classify 的 classifyBook（auto-file 物理挪书用的
 * 就是它），索引类别与实际文件夹口径一致，不会出现「索引说经典、文件在
 * 方药」的错位。都认不出的归「其他」。
 */
const OTHER_TITLE = '其他'
/** 规程（检索、出方口径、剂量速查）单列一类，不算书。 */
const GUIDE_TITLE = '规程'

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  return (bytes / 1048576).toFixed(2) + ' MB'
}

function formatTotal(bytes) {
  return (bytes / 1048576).toFixed(2) + ' MB'
}

function pad(n) {
  return n < 10 ? '0' + n : String(n)
}

function stamp(date) {
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

/**
 * 取样判断一本书是简体还是繁体：按 UTF-8 解码读前 256 KB，
 * 数「爲為經識鬱證脈」等常见繁体字与「为经识郁证脉」等简体字。
 * 二者都有（简繁混排）记「简繁混排」，样本里一个都没有就空着不标。
 * 只读文件头，整本几 MB 的书也不拖慢索引。
 */
const TRAD_PROBE = '爲為經識鬱證脈體氣陽陰虛實熱藥湯溫涼補瀉衛營臟風濕頭頸聲數聽寫讀學'
const SIMP_PROBE = '为经识郁证脉体气阳明虚热药汤温凉补泻卫营脏风湿头颈声数听写读学'

/**
 * 一段取样字节怎么解码：先按 UTF-8（坏字节会变成 U+FFFD 替换符），坏字太多再按 GB18030 重解。
 * 只认 UTF-8 是不够的：库里 GB18030 的 txt 很常见，硬按 UTF-8 解出来汉字数是 0，
 * 繁体书永远标不出字形，索引里要求「简繁双写」的那条规则就白写了。
 * 整本 UTF-16 的按文件头 BOM 解码，取样点落在哪个字节都不会串。
 * @param {Buffer} buf 取样字节
 * @param {string} head 文件头两字节的十六进制（为空表示没读到）
 * @returns {string}
 */
export function decodeSample(buf, head) {
  if (head === 'fffe') return new TextDecoder('utf-16le').decode(buf)
  if (head === 'feff') return new TextDecoder('utf-16be').decode(buf)
  const utf8 = new TextDecoder('utf-8').decode(buf)
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad * 40 <= utf8.length) return utf8
  try {
    return new TextDecoder('gb18030').decode(buf)
  } catch (error) {
    return utf8
  }
}

export function scriptTag(full) {
  let text = ''
  try {
    const fd = openSync(full, 'r')
    try {
      const size = fstatSync(fd).size
      // 分散取样：每 128 KB 取开头 16 KB，最多 4 处；避免只看书头或页码、目录把全书判错。
      const step = 128 * 1024
      const span = 16 * 1024
      const count = size <= step * 2 ? 1 : Math.min(4, Math.ceil(size / step))
      const headBuf = Buffer.alloc(2)
      const headN = readSync(fd, headBuf, 0, 2, 0)
      const head = headN >= 2 ? headBuf.subarray(0, 2).toString('hex') : ''
      const spots = []
      for (let i = 0; i < count; i += 1) spots.push(Math.max(0, Math.min(size - span, Math.floor((size / count) * i))))
      const buf = Buffer.alloc(span)
      for (const at of spots) {
        const n = readSync(fd, buf, 0, buf.length, at)
        if (n > 0) text += decodeSample(buf.subarray(0, n), head)
      }
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    return ''
  }
  let trad = 0
  let simp = 0
  let han = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0x4e00 && code <= 0x9fff) han += 1
    if (TRAD_PROBE.includes(ch)) trad += 1
    else if (SIMP_PROBE.includes(ch)) simp += 1
  }
  // 按全汉字占比算：竖排、一句一行的文本也能判准，不被某一段的字体放大。
  if (han < 300) return ''
  const tradRatio = (trad + 0.5) / (trad + simp + 1)
  if (tradRatio >= 0.85) return '繁体'
  if (tradRatio >= 0.3) return '繁体为主'
  if (tradRatio >= 0.05) return '简繁混排'
  return ''
}

/** 递归时跳过的目录：这些不是书，也不该进索引。 */
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '__pycache__', '_回退备份'])

/** 索引最多收这么多书：再大就只提示，不让一次同步把页面卡死。 */
export const MAX_INDEX_FILES = 2000

/** 不是书的说明文件：语料自带的 README、目录、凡例不进索引，也不进检索。 */
const NON_BOOK = /^(?:readme|说明|目录|凡例)\.md$/i

/** 规程文件所在目录：不算书，但要单列成「规程」，不然模型照着索引找不到规程。 */
const GUIDE_DIRS = new Set(['skills', 'references'])

/**
 * 递归列出书文件。
 * 深度上限 6，防止误把整个磁盘挂载点扫穿；展示路径统一用 `/`，
 * Windows 的 read/glob 也认这种写法，换平台不用改索引。
 * junction/符号链接目录也要跟进去（用户常用 mklink /J 把书挂到资料库），
 * 用 realpath 记住走过的目录，避免环。
 */
function walkFiles(dir, prefix, depth, found, seen = new Set()) {
  if (depth > 6 || found.length > MAX_INDEX_FILES) return found
  let real = ''
  try {
    real = realpathSync(dir)
  } catch (error) {
    return found
  }
  if (seen.has(real)) return found
  seen.add(real)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return found
  }
  for (const entry of entries) {
    if (found.length > MAX_INDEX_FILES) break
    const name = entry.name
    if (name.startsWith('.') || name.startsWith('~$')) continue
    const full = join(dir, name)
    const child = prefix === '' ? name : prefix + '/' + name
    let isDir = entry.isDirectory()
    let isFile = entry.isFile()
    // junction 在 withFileTypes 里常被报成「链接」而不是目录：跟一次 stat 再看。
    if (!isDir && !isFile && entry.isSymbolicLink()) {
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        isFile = st.isFile()
      } catch (error) {
        continue
      }
    }
    if (isDir) {
      if (SKIP_DIRS.has(name)) continue
      // 回退备份、带日期的目录都是备份，里面是旧副本，登进来只会让模型查到过期内容。
      if (name.startsWith('_回退备份')) continue
      walkFiles(full, child, depth + 1, found, seen)
      continue
    }
    if (!isFile) continue
    if (prefix === '' && name === INDEX_FILE) continue
    if (NON_BOOK.test(name)) continue
    // 手工版备份、批次核对清单之类的副产物不进索引。
    if (/^(索引|index)[-_.]/.test(name)) continue
    if (/\.bak([-._]|$)/i.test(name)) continue
    if (/^\.?sync[-_.]|^\.?tmp[-_.]|^\.?build[-_.]/i.test(name)) continue
    if (!TEXT_EXTS.has(extname(name).toLowerCase())) continue
    let size = 0
    try {
      size = statSync(full).size
    } catch (error) {
      size = 0
    }
    const parts = child.split('/')
    const guide = parts.length > 1 && GUIDE_DIRS.has(parts[0])
    found.push({ rel: child, name, size, tag: scriptTag(full), guide })
  }
  return found
}

/** 目录里出现五个分类名之一时，直接按该文件夹归类（外层文件夹优先）。 */
function folderCategory(rel) {
  const parts = rel.split('/')
  parts.pop()
  for (const part of parts) {
    if (CATEGORY_TITLES.includes(part)) return part
  }
  return ''
}

function categoryOf(rel) {
  const forced = folderCategory(rel)
  if (forced !== '') return forced
  // 与 book-classify 同一口径（含《金匮要略方论》归经典等特判），
  // 索引类别和 auto-file 实际挪进的文件夹保持一致。
  return classifyBook({ name: rel }).category
}

function table(rows) {
  const lines = ['| 文件 | 体积 | 字形 |', '|---|---:|---|']
  for (const row of rows) lines.push('| `' + row.rel + '` | ' + formatSize(row.size) + ' | ' + (row.tag || '') + ' |')
  return lines.join('\n')
}

/**
 * 扫描资料库，返回 { markdown, files, bytes, groups }。
 * 目录不存在时 markdown 里写明原因，不抛异常。
 */
export function buildIndexMarkdown(rootDir, now = new Date()) {
  const root = normalizeRoot(rootDir)
  if (root === '' || !existsSync(root)) {
    const text = [
      '# 中医知识库索引',
      '',
      '> 根目录：`' + (root || '（未设置）') + '`',
      '> ' + MARKER + '。',
      '',
      '资料库目录当前不存在：请到「设置 → 中医 · 经方（学习版）｜资料库目录」改成正确路径，本文件会在路径可用后自动重建。',
      '',
    ].join('\n')
    return { markdown: text, files: [], bytes: 0, groups: {} }
  }

  const raw = walkFiles(root, '', 0, [])
  const capped = raw.length > MAX_INDEX_FILES
  const files = capped ? raw.slice(0, MAX_INDEX_FILES) : raw

  const groups = {}
  for (const file of files) {
    // 目录名也参与归类：text/金匮要略/妇人杂病.txt 应归「经典」；
    // 放进五类同名文件夹时优先按文件夹归类。
    const title = file.guide ? GUIDE_TITLE : categoryOf(file.rel)
    if (!groups[title]) groups[title] = []
    groups[title].push(file)
  }

  const order = CATEGORY_TITLES.concat(GUIDE_TITLE, OTHER_TITLE)
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)

  const lines = ['# 中医知识库索引', '']
  lines.push('> 根目录：`' + root + '`　（' + MARKER + '，列出全部文件与体积）')
  lines.push('> 生成时间：' + stamp(now) + '　·　共 ' + files.length + ' 个文件，合计 ' + formatTotal(totalBytes))
  lines.push('> 分类：经典／经典注解／名著／医案／方药；把书放进这五个同名文件夹可强制归类。规程目录（skills／references）单独列在「规程」一类。')
  if (capped) lines.push('> 注意：文件超过 ' + MAX_INDEX_FILES + ' 个，索引只列前 ' + MAX_INDEX_FILES + ' 个，后面的书没有进索引。')
  lines.push('> 字形列：标「繁体」「繁体为主」或「简繁混排」的书，检索同一词要简繁双写（两个字并列成一组），不能只搜简体；只搜简体会漏掉整本繁体书。')
  const skill = join(root, 'skills', 'tcm-jingfang', 'SKILL.md')
  if (existsSync(skill)) lines.push('> 出方所用检索规程见 `skills/tcm-jingfang/SKILL.md`。')
  lines.push('')

  for (const title of order) {
    const rows = groups[title]
    if (!rows || rows.length === 0) continue
    rows.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'))
    // 标题统一成「## 组名 · N 个文件 · 体积」，跟正文里其它分组一个样子。
    const groupBytes = rows.reduce((sum, f) => sum + f.size, 0)
    lines.push('## ' + title + ' · ' + rows.length + ' 个文件 · ' + formatTotal(groupBytes), '', table(rows), '')
  }

  if (files.length === 0) {
    lines.push('## 暂无书目', '', '根目录下没有找到 .md / .txt / .doc / .docx / .pdf / .epub 文件。', '')
  }

  lines.push('## 目录结构', '')
  lines.push('```')
  lines.push('<资料库根目录>/')
  lines.push('├─ 索引.md            # 本文件，插件按目录自动生成，可随时覆盖')
  // 规程目录随不随包发不一定：没有就别在目录树里画出来，免得模型照着空路径去读。
  if (existsSync(skill)) {
    lines.push('├─ text/              # 各书纯文本副本')
    lines.push('└─ skills/tcm-jingfang/SKILL.md  # 用户自放的检索规程')
  } else {
    lines.push('└─ text/              # 各书纯文本副本')
  }
  lines.push('```')
  lines.push('')

  return { markdown: lines.join('\n'), files, bytes: totalBytes, groups }
}

/** 比较时忽略「生成时间」那一行，否则每次启动都会因为时间戳不同而重写文件。 */
function stripStamp(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.startsWith('> 生成时间：'))
    .join('\n')
}

/**
 * 生成并写回 索引.md；书目没变化就不动文件（不刷 mtime，也不改生成时间）。
 * 返回 { changed, path, files, bytes }；目录不存在时 changed=false 且不写盘。
 * 已存在的 索引.md 若不含插件标记（用户手写笔记），跳过覆盖并如实返回
 * reason='user-file'；传了 logger 时同时 warn。
 */
export function writeIndex(rootDir, now = new Date(), logger) {
  const root = normalizeRoot(rootDir)
  if (root === '' || !existsSync(root)) {
    return { changed: false, path: root, files: 0, bytes: 0, reason: 'root-missing' }
  }
  const built = buildIndexMarkdown(root, now)
  const capped = Boolean(built.capped)
  // 库根锁定：索引只能写在设置指定的那个目录里，算出根外就什么都不写。
  const target = childOf(root, INDEX_FILE)
  if (target === '' || !insideRoot(root, target)) {
    return { changed: false, path: '', files: 0, bytes: 0, reason: 'outside-root' }
  }
  let previous = null
  try {
    previous = readFileSync(target, 'utf8')
  } catch (error) {
    previous = null
  }
  // 既有文件没有插件标记＝用户手写的同名笔记：绝不静默覆盖。
  if (previous !== null && !previous.includes(MARKER)) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('中医 · 经方：%s 已存在且非插件生成（疑似用户笔记），跳过覆盖', target)
    }
    return { changed: false, path: target, files: built.files.length, bytes: built.bytes, capped, reason: 'user-file' }
  }
  if (previous !== null && stripStamp(previous) === stripStamp(built.markdown)) {
    return { changed: false, path: target, files: built.files.length, bytes: built.bytes, capped, reason: 'unchanged' }
  }
  // 临时名带上进程号：两个进程同时重建（比如设置里手动点了「重建」又赶上启动自检）
  // 用一个固定名会互相覆盖，rename 还可能拿到别人写了一半的文件。
  const tmp = join(dirname(target), '.' + basename(target) + '.' + process.pid + '.tmp')
  try {
    writeFileSync(tmp, built.markdown, 'utf8')
    renameSync(tmp, target)
  } catch (error) {
    try { unlinkSync(tmp) } catch (e) { /* 没写出来就不用清 */ }
    throw error
  }
  return { changed: true, path: target, files: built.files.length, bytes: built.bytes, capped, reason: 'written' }
}
