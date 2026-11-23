/**
 * 学理模式 · 统一门卫
 *
 * 插件里所有「谁能动什么」的判断都收在这一个文件里，别的文件只调用、不自己另判一套：
 *
 * 出向（出不去）——插件的规则与副作用只作用于自己的会话：
 *   剂量遮挡、资料库提醒、医案归档、调档、闭麦，动手前先经这里认会话。
 *   认会话的引擎在 lib/preset-scope.js，本文件是它唯一的出口；
 *   归档另有「只认本插件预设」的闸（ownPreset），也在这里。
 *
 * 入向（进不来）——外部入口调插件内部功能前必须过这里：
 *   1. 本机 HTTP 通道（查询、打赏、弃局）：fromThisMachine 是唯一一份本机判断，
 *      连接来源地址与 Host 头两样都要对，远程伪造一律拒；
 *      会改东西的通道（删局、弃局）另过 fromLocalPage：Origin／Referer 也得是本机页面，
 *      挡住本机任意网页发起的 CSRF；
 *   2. 删局、还档位、归档锁局：只认插件面板自己开的局（createGuard），
 *      别的会话（含主聊天里手打的局）带个会话号进来，一律不动。
 *
 * 默认「认不出就拒」：登记没报上来、判断函数抛错，都按不是自己的处理——
 * 宁可少管，不可乱管。门卫自己不抛异常：它倒了等于谁都拒，不拖累宿主。
 */
import { readPending } from './purge.js'

/* ── 出向：会话识别（引擎在 preset-scope.js，这里是唯一出口） ── */

export { isTcmSession, looksTcmPrompt, tcmVerdict, versionOf } from './preset-scope.js'

/** 本插件预设 id；只有这个预设（及旧版别名）的会话才归档医案。 */
export const OWN_PRESET = 'dsh-tcm-xueli'
/** 旧版预设 id；早先开的中医会话仍可能用它，继续认。 */
export const LEGACY_PRESETS = new Set(['dsh-tcm', 'tcm'])

/**
 * 会话当前是不是本插件的预设（归档闸）。
 * currentPreset 读当前预设（空白窗口里换过预设时 header 不会变）；
 * 读不到、抛错都退回 header 里创建时的预设。两样都不是本插件的就不归档。
 * @param {object} session 会话
 * @param {{currentPreset?: (session: any) => (string|null|undefined), preset?: string}} [options]
 * @returns {boolean}
 */
export function ownPreset(session, { currentPreset, preset = OWN_PRESET } = {}) {
  let presetId
  if (typeof currentPreset === 'function') {
    try {
      presetId = currentPreset(session)
    } catch {
      presetId = undefined
    }
  }
  if (presetId === undefined || presetId === null) presetId = session?.header?.agentPreset
  return presetId === preset || LEGACY_PRESETS.has(presetId)
}

/* ── 入向：本机判断（三条 HTTP 通道共用这一份） ── */

/**
 * 请求是否来自本机页面：连接来源地址与 Host 头两样都要对。
 * Host 头是客户端随便写的，光看它挡不住远程伪造；来源地址由系统给，伪造不了。
 * @param {object} req HTTP 请求（要有 socket.remoteAddress 与 headers.host）
 * @returns {boolean}
 */
export function fromThisMachine(req) {
  const remote = String((req && req.socket && req.socket.remoteAddress) || '')
  const host = String((req && req.headers && req.headers.host) || '')
  const localRemote = /^(127\.|::1$|::ffff:127\.)/.test(remote)
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
  return localRemote && localHost
}

/** 这个 Origin／Referer 是不是回环来源（协议、主机名都要对；端口不限）。 */
function localPageSource(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(url.hostname)
}

/**
 * 请求是不是本机页面发出来的（只给会改东西的通道用：删局、弃局）。
 * 光查连接地址挡不住本机 CSRF：任意网页都能用 <img>／no-cors fetch 打到回环地址。
 * 所以再加一道：Origin 存在就必须是回环来源；没有 Origin 才看 Referer，
 * Referer 存在也必须是回环来源；两样都缺才放行（同源 GUI 的 GET 带本站 Referer，能过；
 * 跨站攻击必带外站 Origin／Referer，一律拒；Origin 为 "null" 的沙箱页也拒）。
 * @param {object} req HTTP 请求
 * @returns {boolean}
 */
export function fromLocalPage(req) {
  if (!fromThisMachine(req)) return false
  const headers = (req && req.headers) || {}
  const origin = String(headers.origin || '').trim()
  if (origin) return localPageSource(origin)
  const referer = String(headers.referer || '').trim()
  if (referer) return localPageSource(referer)
  return true
}

/* ── 入向：面板局归属（删局、还档位、归档的闸） ── */

/**
 * 造一个门卫实例：插件每装载一次造一个，热重载不背旧实例的登记。
 * 面板局的认人函数晚绑定——问诊那块装好后才把「哪些局是我开的」报上来；
 * 没报上来之前，删局／还档位／归档的请求一律拒（宁可少删，不可误删）。
 * 重启后内存登记丢了，真删另认家目录的待清名单（名单上只记面板开的局）。
 */
export function createGuard() {
  let isPanelRound = null

  /** 是不是面板开的局：空号、没登记、认人函数抛错，一律按不是。 */
  const panelOwned = (id) => {
    const key = String(id || '').trim()
    if (!key || typeof isPanelRound !== 'function') return false
    try {
      return !!isPanelRound(key)
    } catch {
      return false
    }
  }

  return {
    /** 问诊块把面板局认人函数报到这里；传进来的不是函数就当没报。 */
    bindPanel(fn) {
      isPanelRound = typeof fn === 'function' ? fn : null
    },
    /** 是不是面板开的局（内存登记）。 */
    panelOwned,
    /** 还档位、清协议状态：只认面板开的局，手打局与别的会话一律拒。 */
    canRelease(id) {
      return panelOwned(id)
    },
    /** 归档锁局：只认面板开的局。 */
    canArchive(id) {
      return panelOwned(id)
    },
    /** 真删：面板开的局，或待清名单上还没清掉的局（重启后面板补删也认）。 */
    canPurge(id) {
      if (panelOwned(id)) return true
      const key = String(id || '').trim()
      if (!key) return false
      try {
        return readPending().includes(key)
      } catch {
        return false
      }
    },
  }
}