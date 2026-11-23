import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromLocalPage, OWN_PRESET } from './guard.js'
import { dshHome, purgeSession } from './purge.js'

const LOG = '学理模式：'

/** 本面板认自己那一局的记号：标题一律以它开头。 */
export const TEACH_TITLE = '答疑·'

const SESSION_ID = /^[A-Za-z0-9._-]{1,120}$/

/**
 * 从投影缓存里读这一局的标题和预设。
 * 宿主没有「查标题」的公开接口，投影缓存是唯一稳的读法；
 * 读不到、结构变了，都返回 null —— 认不出就不许删，别猜。
 */
export function teachMetaOf(id, home = dshHome()) {
  const key = String(id || '').trim()
  if (!SESSION_ID.test(key)) return null
  const read = (file) => {
    try {
      if (!existsSync(file)) return null
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      const rows = doc && doc.record && doc.record.rows
      if (!rows) return null
      const title = rows.title && typeof rows.title.val === 'string' ? rows.title.val : ''
      const preset = rows.agentPreset && typeof rows.agentPreset.val === 'string' ? rows.agentPreset.val : ''
      return { title, preset }
    } catch {
      return null
    }
  }
  // 现在的 DSH：一局一个文件；老版本是一个大文件，顺手也认一下。
  const one = read(join(home, 'storages', 'session_projcache', 'sessions', key + '.json'))
  if (one) return one
  const big = read(join(home, 'storages', 'session_projcache.json'))
  return big
}

/** 模拟问诊局的标题前缀：这种局走 sim-end 自己的真删通道，不许从这条通道删。 */
export const SIM_TITLE = '问诊·局'

/**
 * 这一局能不能从本通道真删：本插件预设开的、且不是模拟问诊局。
 * 答疑局（「答疑·」前缀）与学习版面板的普通局都认（工作台的真删按钮走这里）；
 * 模拟问诊局（「问诊·局」前缀）各有各的收局办法（sim-end 带自己的门卫），
 * 不许从这条通道删，防止误删、也防止绕过模拟局的门卫。
 * 标题读不出来（空）就当认不出，宁可不删——没法排除它是模拟局。
 */
export function isOwnSession(id, home = dshHome()) {
  const meta = teachMetaOf(id, home)
  if (!meta) return false
  return meta.preset === OWN_PRESET
    && typeof meta.title === 'string' && meta.title.length > 0
    && !meta.title.startsWith(SIM_TITLE)
}

/**
 * 认人（异步版）：先看投影缓存——快，老会话都在里面；
 * 缓存还没落盘的（最常见的是正在用的这一局，投影要等宿主刷盘才写文件），
 * 再问宿主这一局现在跑的是哪个预设、标题叫什么。
 * 本插件预设＋标题非空＋不是模拟问诊局才认；认不出就不许删，别猜。
 */
export async function ownsSession(ctx, id, home = dshHome()) {
  if (isOwnSession(id, home)) return true
  let query
  try {
    query = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  } catch {
    query = undefined
  }
  if (!query || typeof query.observeSession !== 'function') return false
  try {
    const seen = await query.observeSession(String(id))
    const values = seen && seen.projections && seen.projections.values
    const preset = (values && values.agentPreset) || (seen && seen.header && seen.header.agentPreset)
    const title = values && typeof values.title === 'string' ? values.title : ''
    return typeof preset === 'string' && preset === OWN_PRESET
      && title.length > 0 && !title.startsWith(SIM_TITLE)
  } catch {
    return false
  }
}

/**
 * 本插件的真删小通道：把本插件预设开的、非模拟问诊的那一局真删掉
 * （答疑局＋学习版面板的普通局，工作台的真删按钮也走这里）。
 * 宿主只给归档不给删，真删得自己动手（见 lib/purge.js）。
 * 认人只认本插件预设的非模拟局、只接本机页面，别的请求一律拒；
 * 模拟问诊局走 sim-end 自己的通道（带自己的门卫），不从这条删。
 */
export async function mountTeachRoute(ctx, options = {}) {
  const log = options.log || LOG
  const routePath = options.path || '/dsh-tcm-xueli/teach-end'
  // 认人：缓存里查得到就快查；查不到再问宿主（正在用的这一局往往还没写缓存）。
  const owns = typeof options.owns === 'function' ? options.owns : (id) => ownsSession(ctx, id)
  // 删这一下默认交给 purgeSession；测试可以换成假的，看得见到底交没交。
  const purge = typeof options.purge === 'function' ? options.purge : (id) => purgeSession(ctx, id)

  let webServer = ctx.get ? ctx.get('webServer') : undefined
  for (let i = 0; i < 20 && (!webServer || typeof webServer.register !== 'function'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    webServer = ctx.get ? ctx.get('webServer') : undefined
  }
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('这台 DSH 没有 Web 服务，答疑的删除通道挂不上')
  }

  return webServer.register({
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
      // Host 头是客户端随便写的，只认真正的本机连接；删局会改东西，
      // 还得是本机页面发的（Origin／Referer 也是回环），挡住本机网页的 CSRF。
      if (!fromLocalPage(req)) {
        send(403, { ok: false, reason: '只接受本机页面。' })
        return
      }
      let url
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1')
      } catch {
        send(400, { ok: false, reason: '参数看不懂。' })
        return
      }
      const doing = String(url.searchParams.get('doing') || '').trim()
      const sessionId = String(url.searchParams.get('session') || '').slice(0, 120)
      if (doing !== 'delete') {
        send(400, { ok: false, reason: '只认删除。' })
        return
      }
      if (!SESSION_ID.test(sessionId)) {
        send(400, { ok: false, reason: '会话号看不懂。' })
        return
      }
      let mine = false
      try {
        mine = !!(await owns(sessionId))
      } catch {
        mine = false
      }
      // 门卫：不是本面板开的那一局，一律不删（防止误删别的会话）。
      if (!mine) {
        send(403, { ok: false, reason: '这一局不是本插件开的（或是模拟问诊局），不能在这里删。' })
        return
      }
      Promise.resolve()
        .then(() => purge(sessionId))
        .then((got) => {
          send(200, { ok: !!(got && got.ok), removed: (got && got.removed) || [], reason: (got && got.reason) || '' })
        })
        .catch((error) => {
          ctx.logger?.warn?.(log + '答疑这一局没删干净：' + String((error && error.message) || error))
          send(500, { ok: false, reason: '没删掉，稍后再试一次。' })
        })
    },
  })
}