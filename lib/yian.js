/**
 * 中医 · 经方 · 医案浏览（只读）
 *
 * 工作台「添加医案」按钮背后的一条本机只读通道：
 * - 不带 file 参数：列出资料库 医案/ 里的 .md 医案（标题＋修改时间，新的在前）；
 * - 带 file=某某.md：读这一份医案，回标题、创建/更新时间与正文（Markdown）。
 *
 * 安全边界（与查询/穴位通道同一套门卫）：
 * - 只接 GET、只认本机页面（lib/guard.js fromLocalPage：回环地址＋Host，Origin／Referer 也得是本机）；
 *   医案是个人健康记录，比古籍检索更敏感，故连只读也挡外站页面伪造请求；
 * - file 只认 basename（不许带路径分隔符、不许 . / ..），且必须落在 医案/ 目录里（库根复查）；
 * - 只读不写：这条通道从不改任何文件。
 *
 * 任何异常都只回 {ok:false, reason} 或记日志，绝不向上抛：浏览失败不能影响主体。
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fromLocalPage } from './guard.js'
import { insideRoot } from './kb-root.js'
import { RECORD_DIR } from './records.js'

/** 列表最多回多少份，免得大库把前端撑爆。 */
const LIST_KEEP = 300
/** 单份医案最大读多少字节（超过只回前一段，避免超大文件卡住）。 */
const READ_MAX = 2 * 1024 * 1024
/** 文件名最长认多少字符。 */
const NAME_MAX = 200

/** 读文件头若干字节（拿 frontmatter 标题用，不必整份读进来）。 */
function readHead(file, n = 4096) {
  let fd = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.slice(0, got).toString('utf8')
  } catch (error) {
    return ''
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch (error) { /* 已关 */ } }
  }
}

/** 拆 frontmatter：开头 --- 到下一行 --- 之间是元信息，其余是正文。 */
export function parseFrontmatter(text) {
  const raw = String(text ?? '')
  const meta = {}
  if (!raw.startsWith('---')) return { meta, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta, body: raw }
  const head = raw.slice(3, end)
  for (const line of head.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (!key) continue
    // 元信息值是 JSON 字符串（带引号）；解不开就原样留着。
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch (error) { /* 原样 */ }
    }
    meta[key] = value
  }
  // 去掉 frontmatter 与正文之间的空行分隔，让正文直接从内容起头。
  const body = raw.slice(end + 4).replace(/^[\r\n]+/, '')
  return { meta, body }
}

/** 从文件头里取标题：优先 frontmatter「标题」，退回正文第一个 # 行，再退回文件名。 */
function titleOf(file, name) {
  const head = readHead(file)
  const { meta, body } = parseFrontmatter(head)
  if (typeof meta['标题'] === 'string' && meta['标题'].trim()) return meta['标题'].trim()
  const m = body.match(/^#\s+(.+)$/m)
  if (m && m[1].trim()) return m[1].trim()
  return name.replace(/\.md$/i, '')
}

/**
 * 列出资料库 医案/ 里的 .md 医案，按修改时间新的在前。
 * @param {string} kb 资料库根目录
 * @returns {{file: string, title: string, at: number}[]}
 */
export function listYian(kb) {
  const root = String(kb || '')
  if (!root || !existsSync(root)) return []
  const dir = join(root, RECORD_DIR)
  if (!insideRoot(root, dir) || !existsSync(dir)) return []
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md'))
  } catch (error) {
    return []
  }
  const out = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      if (!insideRoot(dir, file)) continue
      const st = statSync(file)
      if (!st.isFile()) continue
      out.push({ file: name, title: titleOf(file, name), at: st.mtimeMs || 0 })
    } catch (error) {
      // 单份读不到就跳过，不影响其余。
    }
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0))
  return out.slice(0, LIST_KEEP)
}

/** file 参数是否安全：只认 basename、.md 结尾、不超长、不是 . / .. 。 */
export function safeYianName(file) {
  if (typeof file !== 'string' || !file || file.length > NAME_MAX) return false
  if (file === '.' || file === '..') return false
  if (file.indexOf('/') >= 0 || file.indexOf('\\') >= 0 || file.indexOf('\0') >= 0) return false
  if (basename(file) !== file) return false
  return file.toLowerCase().endsWith('.md')
}

/**
 * 读一份医案。只读 医案/ 目录里、basename 合法的 .md。
 * @param {string} kb 资料库根目录
 * @param {string} file 文件名（basename）
 * @returns {{ok: true, file: string, title: string, created: string, updated: string, body: string} | {ok: false, reason: string}}
 */
export function readYian(kb, file) {
  const root = String(kb || '')
  if (!root || !existsSync(root)) return { ok: false, reason: '资料库目录没设或不存在。' }
  if (!safeYianName(file)) return { ok: false, reason: '文件名不合法。' }
  const dir = join(root, RECORD_DIR)
  const path = join(dir, file)
  // 双重库根复查：既要在资料库里，也要确实在 医案/ 里（防 basename 花样越界）。
  if (!insideRoot(root, path) || !insideRoot(dir, path)) return { ok: false, reason: '这份医案不在资料库医案目录里。' }
  if (!existsSync(path)) return { ok: false, reason: '这份医案不在了。' }
  let text = ''
  let truncated = false
  let size = 0
  try {
    const st = statSync(path)
    if (!st.isFile()) return { ok: false, reason: '这不是一个医案文件。' }
    size = st.size
    if (st.size > READ_MAX) {
      text = readHead(path, READ_MAX)
      truncated = true
    } else {
      text = readFileSync(path, 'utf8')
    }
  } catch (error) {
    return { ok: false, reason: '医案读不出来。' }
  }
  const { meta, body } = parseFrontmatter(text)
  const title = typeof meta['标题'] === 'string' && meta['标题'].trim() ? meta['标题'].trim() : file.replace(/\.md$/i, '')
  return {
    ok: true,
    file,
    title,
    created: typeof meta['创建'] === 'string' ? meta['创建'] : '',
    updated: typeof meta['更新'] === 'string' ? meta['更新'] : '',
    body,
    truncated,
    size,
  }
}

/**
 * 开一条只读医案浏览通道。
 * @param {object} ctx 插件 context
 * @param {{rootDir: () => string, path?: string, log?: string}} options
 */
export async function mountYianRoute(ctx, options) {
  const log = options.log || '[医案浏览]'
  const routePath = options.path || '/dsh-tcm-xueli/yian'

  let webServer = ctx.get ? ctx.get('webServer') : undefined
  for (let i = 0; i < 20 && (!webServer || typeof webServer.register !== 'function'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    webServer = ctx.get ? ctx.get('webServer') : undefined
  }
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('这台 DSH 没有 Web 服务，浏览不了医案')
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
      if (!fromLocalPage(req)) {
        send(403, { ok: false, reason: '只接受本机页面的浏览。', files: [] })
        return
      }
      let url
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1')
      } catch {
        send(400, { ok: false, reason: '参数看不懂。', files: [] })
        return
      }
      const root = options.rootDir ? options.rootDir() : ''
      if (!root) {
        send(200, { ok: false, reason: '资料库目录还没设。', files: [] })
        return
      }
      try {
        const file = url.searchParams.get('file')
        if (file) {
          send(200, readYian(root, file))
        } else {
          send(200, { ok: true, files: listYian(root) })
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        ctx.logger?.warn?.(log + '浏览出错：' + message)
        send(200, { ok: false, reason: '医案浏览没跑通，请稍后再试；细节已记日志。', files: [] })
      }
    },
  })

  ctx.logger?.info?.(log + '医案浏览通道已开：' + routePath)
  return () => {
    try { dispose?.() } catch (error) {
      ctx.logger?.warn?.(log + '关闭医案浏览通道出错：' + String(error && error.message ? error.message : error))
    }
  }
}