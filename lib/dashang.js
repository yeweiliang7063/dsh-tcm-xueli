/**
 * 学理模式 · 打赏码通道
 *
 * 回答结尾要摆两张收款码（支付宝、微信）。图片地址只写「绝对本地路径」：
 * 宿主认这种写法，会把它换成当前页面源的 api/file 地址再去读盘，桌面版
 * （页面跑在 dsh-app://app）和浏览器里都通，跟端口无关——重启、换端口、
 * 重开页面，老回答里的码图都还在。
 *
 * 反过来写的两种都试过了，都不成：http://127.0.0.1:端口/... 会被「端口每次
 * 启动都变」拖死，桌面版还容易撞上跨源限制；/dsh-tcm-xueli/... 这种相对地址
 * 会被宿主当成「盘符根下的路径」去找文件，最后只剩一句「图片无法预览」。
 *
 * 下面那条只读通道（/dsh-tcm-xueli/dashang/*.jpg）照旧留着：它是给人直接在
 * 浏览器里打开看码用的，回答里的图片已经不依赖它。整条通道都是可选的：
 * 挂不上只等于少一个网页入口，不影响问诊与出方。
 *
 * 只发这两张图，不认目录遍历、不认其它文件名；只接受本机页面。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromThisMachine } from './guard.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 图片目录（随包 assets/dashang）。 */
export const DASHANG_DIR = path.join(HERE, '..', 'assets', 'dashang')
/** 对外地址前缀：与 lib/search.js 的查询通道同一套命名。 */
export const DASHANG_PREFIX = '/dsh-tcm-xueli/dashang/'

/**
 * 回答里那张拼好的图（左边支付宝、右边微信，只留二维码那一块），
 * 外加两张单张的裁图，供人直接打开细看。文件名一律小写比对；不在这里的一律 404。
 */
export const DASHANG_FILES = ['dashang-qr.png', 'alipay-qr.jpg', 'wechat-qr.jpg']
/** 回答里用的是拼好的那一张：左右并排、只留码区，比两张原图小得多。 */
export const DASHANG_QR = 'dashang-qr.png'
/** 打赏区的标题行：代码按这一句判断「这段加过了」，别再重复加。 */
export const DASHANG_TIP = '**这一节要是帮到你，可以请作者喝杯茶：**'
/** 一张图的响应体：读盘失败返回 null，由调用方回 404。 */
export function readDashangImage(name) {
  const key = String(name || '').toLowerCase()
  if (!DASHANG_FILES.includes(key)) return null
  const file = path.join(DASHANG_DIR, key)
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/** 请求是否来自本机页面：判断统一收在门卫（lib/guard.js），这里只转手，别再另写一套。 */
export { fromThisMachine }

/** 单次请求处理：纯函数式，方便单测直接喂假 req / res。 */
export function dashangHandler(req, res) {
  const method = String(req.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (!fromThisMachine(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('只接受本机页面读取。')
    return
  }
  let url
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const raw = url.pathname.startsWith(DASHANG_PREFIX) ? url.pathname.slice(DASHANG_PREFIX.length) : ''
  const name = path.basename(decodeURIComponent(raw || ''))
  const body = readDashangImage(name)
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('没有这张图。')
    return
  }
  // 类型按文件头魔数认：PNG 以 89 50 4E 47 开头，其余一律按 JPEG 发。
  const isPng = body.length >= 4 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
  res.writeHead(200, {
    'content-type': isPng ? 'image/png' : 'image/jpeg',
    'content-length': body.length,
    'cache-control': 'public, max-age=86400',
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/**
 * 把打赏码通道挂到 Web 服务上；返回一个关闭函数。
 * Web 服务比插件晚就位是常态，最多等十秒。
 */
export async function mountDashangRoute(ctx) {
  if (!ctx || typeof ctx.get !== 'function') throw new Error('没有可用的插件上下文')
  let webServer = ctx.get('webServer')
  for (let i = 0; i < 20 && (!webServer || typeof webServer.register !== 'function'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    webServer = ctx.get('webServer')
  }
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('这台 DSH 没有 Web 服务，打赏码发不出去')
  }
  const disposes = []
  for (const name of DASHANG_FILES) {
    disposes.push(webServer.register({ kind: 'exact', path: DASHANG_PREFIX + name, handler: dashangHandler }))
  }
  ctx.logger?.info?.('学理模式：打赏码通道已开：' + DASHANG_PREFIX)
  return () => {
    for (const dispose of disposes) {
      try { dispose?.() } catch { /* 进程退出会一起回收 */ }
    }
  }
}
/* ── 由代码追加的打赏区（模型不写，省得它改网址、改措辞） ── */

/**
 * 打赏码在回答里的写法：绝对本地路径，分隔符一律用正斜杠。
 *
 * 路径一个字都不写死：DASHANG_DIR 是从这个文件自己的位置（import.meta.url）
 * 往上一级退出来的，插件装在哪、装成什么样，算出来就是哪。
 * 反斜杠在 Markdown 里是转义符，`D:\...` 会把路径吃坏；`D:/...` 宿主一样认。
 */
export function dashangImageUrl(file) {
  const name = String(file || '')
  if (!DASHANG_FILES.includes(name)) return ''
  return path.resolve(DASHANG_DIR, name).split(path.sep).join('/')
}

/**
 * 打赏区的整段 Markdown：分隔线、标题、两张码、一句自愿的话。
 * rounds 给了就在标题下多一句「已满多少局」，让医生知道这一块为什么这会儿才出来。
 */
export function dashangBlock(rounds) {
  const nth = Number(rounds)
  return [
    '---',
    '',
    DASHANG_TIP,
    ...(Number.isFinite(nth) && nth > 0 ? ['', `（十局一摆：模拟问诊到这里已经判完 ${nth} 局。）`] : []),
    '',
    // 一张图里左右并排：左边支付宝、右边微信，四周只留扫码要用的白边。
    `![支付宝（左）与微信（右）打赏码](${dashangImageUrl(DASHANG_QR)})`,
    '',
    '打赏全凭自愿，跟辨证结论、方子好坏都没关系，不打赏也照常把话讲完。',
  ].join('\n')
}

/**
 * 回答末尾那两行免责声明：这是硬性口径（lib/gear.js 第 17 条），不是可有可无的装饰。
 * 模型写了就照它的；漏写由代码在收尾补上，一个字都不许少。
 * key 是识重词：回答里已经出现这个片段，就说明这一行写过了，不再重复贴。
 */
export const DISCLAIMER = [
  {
    key: '本节仅供学习研究',
    line: '【中医 · 经方（学习版）】本节仅供学习研究，不构成诊疗建议；如需用药或施针请由执业中医师面诊。',
  },
  {
    key: 'AI 有幻觉',
    line: '⚠️ AI 有幻觉：以上内容由人工智能生成，可能编造原文、记错条文或张冠李戴，请自行核对原书后再用。',
  },
]

/** 回答收尾那两句声明里的识别词：见到任意一句就摆打赏区。 */
export const GIFT_SIGNS = DISCLAIMER.map((item) => item.key)

/**
 * 这份回答要不要在结尾补打赏区：只看收尾那两句声明——
 * 「【中医 · 经方（学习版）】本节仅供学习研究……」「⚠️ AI 有幻觉……」，见到任一句就算讲到头了。
 * 问诊轮也一样：只要这两句出了，就是一份给了说法的回答，照样在末尾摆。
 */
export function hasGiftSign(text) {
  const body = String(text || '')
  if (body === '') return false
  return GIFT_SIGNS.some((sign) => body.includes(sign))
}

/**
 * 还缺哪几行声明：按原顺序回缺的那些行，一行都少不了。
 * 代码兜底就靠它——模型漏写几行，收尾就补几行。
 */
export function missingDisclaimer(text) {
  const body = String(text || '')
  return DISCLAIMER.filter((item) => !body.includes(item.key)).map((item) => item.line)
}
