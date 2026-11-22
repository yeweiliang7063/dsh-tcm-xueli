/**
 * 学习版 · 穴位图
 *
 * 「资料查询」查到穴位时，面板上出一张示意图：左边一个人形小图标出穴在
 * 身上的大概位置，右边把这个部位放大，画个红圈标清楚。
 *
 * 图是现画的，不存位图：assets/acupoints/points.json 里存的是三百六十一个
 * 经穴的三维坐标（定位文字据 GB/T 12346—2021《经穴名称与定位》，坐标整理自
 * Honglouqaz/tcm-meridian-3d，CC BY 4.0），收到请求按穴拼一张 SVG 出去。
 * 好处是只有一份数据、没有几百张图片，缩放也不糊。
 *
 * 整段包在 try/catch 里：画不出来只等于这一块空白，不影响资料查询和主体启动。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromThisMachine } from './guard.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 穴位坐标数据与（将来的）图片都放这个目录。 */
export const ACUPOINT_DIR = path.join(HERE, '..', 'assets', 'acupoints')
/** 穴位图通道：/dsh-tcm-xueli/acupoint/<编号>.svg */
export const ACUPOINT_PREFIX = '/dsh-tcm-xueli/acupoint/'

const DATA_FILE = path.join(ACUPOINT_DIR, 'points.json')

/** 数据出处，面板上要原样标出来（CC BY 4.0 要求署名）。 */
export const ACUPOINT_SOURCE = 'GB/T 12346—2021 经穴名称与定位；坐标整理自 Honglouqaz/tcm-meridian-3d（CC BY 4.0）'

/* ── 数据 ── */

/**
 * 读一遍穴位数据。文件缺了、坏了都只当没有数据，不抛给上层。
 * @returns {{points: any[], byName: Map<string, any>, byPinyin: Map<string, any>, meridians: Map<number, string>}}
 */
function readData() {
  const empty = { points: [], byName: new Map(), byPinyin: new Map(), meridians: new Map() }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const points = Array.isArray(parsed && parsed.points) ? parsed.points : []
    const byName = new Map()
    const byPinyin = new Map()
    const meridians = new Map()
    for (const one of points) {
      if (!one || !one.name || !one.pos) continue
      byName.set(String(one.name), one)
      if (one.py) byPinyin.set(String(one.py).toUpperCase(), one)
      if (one.mi !== undefined) meridians.set(one.mi, String(one.meridian || ''))
    }
    return { points, byName, byPinyin, meridians }
  } catch {
    return empty
  }
}

const DATA = readData()

/** 全部穴位（只读）。 */
export const ACUPOINTS = DATA.points

/**
 * 古书里的简称、别名、俗称，按正名归一。
 * 只收常用的：查「三里」给足三里，查「人中」给水沟，查「虎口」给合谷。
 */
const ALIASES = new Map(Object.entries({
  三里: '足三里',
  下陵: '足三里',
  鬼邪: '足三里',
  虎口: '合谷',
  绝骨: '悬钟',
  人中: '水沟',
  脐中: '神阙',
  丹田: '关元',
  下纪: '关元',
  脖胦: '气海',
  下肓: '气海',
  吕细: '太溪',
  百虫窠: '血海',
  太仓: '中脘',
  胃管: '中脘',
  尾闾: '长强',
  穷骨: '长强',
  玉泉: '中极',
  气原: '中极',
  精宫: '志室',
  百劳: '大椎',
  承命: '三阴交',
  大冲: '太冲',
  血郄: '委中',
  热府: '风池',
  阳陵: '阳陵泉',
  筋会: '阳陵泉',
  阴陵: '阴陵泉',
  兑冲: '神门',
  锐中: '神门',
  髀枢: '环跳',
  环谷: '环跳',
  龙渊: '然谷',
  然骨: '然谷',
  伏白: '复溜',
  昌阳: '复溜',
  外命: '复溜',
  地冲: '涌泉',
  下昆仑: '昆仑',
  元儿: '膻中',
  上气海: '膻中',
  屏翳: '会阴',
  长溪: '天枢',
  谷门: '天枢',
  长谷: '天枢',
  阳泽: '曲池',
  中魁: '阳溪',
  鬼臣: '曲池',
  气府: '京门',
  气俞: '京门',
  长平: '章门',
  肋髎: '章门',
}))

/** 查询词收拾干净：去空白、去引号、去尾巴上的「穴」、去括注。 */
function cleanQuery(raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s　"'“”‘’·、,，。.；;：:]/g, '')
    .replace(/穴$/, '')
}

/**
 * 按名字找穴位。认：正名、常用别名、拼音（不分大小写），以及唯一后缀。
 * @param {string} raw 用户输入
 * @returns {object|null}
 */
export function findAcupoint(raw) {
  const q = cleanQuery(raw)
  if (!q) return null
  const byName = DATA.byName.get(q)
  if (byName) return byName
  const alias = ALIASES.get(q)
  if (alias && DATA.byName.has(alias)) return DATA.byName.get(alias)
  const byPinyin = DATA.byPinyin.get(q.toUpperCase())
  if (byPinyin) return byPinyin
  /* 只认「唯一的后缀」：查「太溪」不会把「阴谷」带出来，避免乱认。 */
  if (q.length >= 2) {
    let hit = null
    for (const one of DATA.points) {
      if (!String(one.name).endsWith(q)) continue
      if (hit) return null
      hit = one
    }
    if (hit) return hit
  }
  return null
}

/** 给面板用的精简字段。 */
export function acupointInfo(point) {
  if (!point) return null
  return {
    id: point.id,
    name: point.name,
    py: point.py,
    meridian: point.meridian,
    location: point.location || '',
    func: point.func || '',
    image: ACUPOINT_PREFIX + encodeURIComponent(String(point.id)) + '.svg',
    source: ACUPOINT_SOURCE,
  }
}

/* ── 画图 ── */

/** 画布 440×400：左边人形小图，正中放大圆。 */
const W = 440
const H = 400

/** 数据里的人体中轴不在 0，在 x≈0.126，画之前先挪到正中。 */
const CX = 0.126
/** 肩关节位置（数据坐标，挪过中轴之后）。 */
const SH_X = 0.72
const SH_Y = 1.5
/** 数据是平举（T-pose），画的时候把胳膊绕肩往下转 72°，才像站着的姿态。 */
const ARM = (72 * Math.PI) / 180

/** 人形小图：屏幕中心与缩放。 */
const BODY_CX = 56
const BODY_CY = 202
const BODY_S = 30
const Y_MID = -1.34
/** 放大圆。 */
const ZOOM_CX = 220
const ZOOM_CY = 200
const ZOOM_R = 100

/** 部位 → 放大半径（坐标单位）。 */
const REGION_R = {
  head: 0.38,
  neck: 0.34,
  hand: 0.4,
  arm: 0.52,
  trunk: 0.62,
  thigh: 0.62,
  leg: 0.62,
  foot: 0.44,
}

/** 这个穴在身体的哪一块（用原始坐标判断，跟正背面无关）。 */
export function regionOf(pos) {
  const x = Math.abs(Number(pos.x) - CX)
  const y = Number(pos.y)
  if (y > 2.05) return 'head'
  if (x > 3.05) return 'hand'
  if (x > 0.88) return 'arm'
  if (y > 1.95) return 'neck'
  if (y > -1.25) return 'trunk'
  if (y > -3.0) return 'thigh'
  if (y > -5.05) return 'leg'
  return 'foot'
}

/** 三维坐标 → 二维示意坐标（x 归中、胳膊转下来）。 */
function project(point) {
  const x0 = Number(point.pos.x) - CX
  let x = x0
  let y = Number(point.pos.y)
  const z = Number(point.pos.z)
  if (Math.abs(x0) > SH_X) {
    const side = x0 > 0 ? 1 : -1
    const dx = Math.abs(x0) - SH_X
    x = side * (SH_X + dx * Math.cos(ARM))
    y = SH_Y - dx * Math.sin(ARM)
  }
  return { x, y, z }
}

/**
 * 这个穴该看正面还是背面。躯干、头看 z（+ 为身前）；腿上的 z 整体偏负
 * （小腿中轴在身后），门槛放低到 -0.32；手、足两面差不多，统一按正面画。
 */
function viewOf(point) {
  const region = regionOf(point.pos)
  const z = Number(point.pos.z)
  if (region === 'arm' || region === 'hand' || region === 'foot') return 'front'
  if (region === 'thigh' || region === 'leg') return z >= -0.32 ? 'front' : 'back'
  return z >= -0.05 ? 'front' : 'back'
}

/** 数字固定小数位，省得 SVG 里一堆长尾。 */
function n(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, '') || '0'
}

/**
 * Catmull-Rom 平滑：给一串地标点，采成一条顺滑的路径。
 * @param {number[][]} pts
 * @param {boolean} closed
 */
function smoothPath(pts, closed) {
  const list = pts
  const out = []
  const count = list.length
  if (count < 2) return ''
  const at = (i) => list[(i + count) % count]
  out.push(`M${n(list[0][0])},${n(list[0][1])}`)
  const last = closed ? count : count - 1
  for (let i = 0; i < last; i++) {
    const p0 = closed ? at(i - 1) : list[Math.max(0, i - 1)]
    const p1 = list[i]
    const p2 = closed ? at(i + 1) : list[Math.min(count - 1, i + 1)]
    const p3 = closed ? at(i + 2) : list[Math.min(count - 1, i + 2)]
    for (let step = 1; step <= 6; step++) {
      const t = step / 6
      const t2 = t * t
      const t3 = t2 * t
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      out.push(`L${n(x)},${n(y)}`)
    }
  }
  if (closed) out.push('Z')
  return out.join('')
}

/** 右半边身体的地标：颈根 → 肩、胸、腰、髋 → 腿 → 脚 → 内侧回到胯。 */
const BODY_HALF = [
  [0.2, 1.86], [0.45, 1.76], [0.68, 1.62], [0.79, 1.45], [0.79, 1.05],
  [0.74, 0.55], [0.71, 0.1], [0.73, -0.4], [0.77, -0.8], [0.79, -1.1],
  [0.81, -1.5], [0.8, -1.95], [0.77, -2.35], [0.72, -2.8], [0.71, -3.2],
  [0.69, -3.75], [0.67, -4.35], [0.65, -4.9], [0.63, -5.15],
  [0.68, -5.28], [0.74, -5.45], [0.73, -5.6], [0.66, -5.7], [0.5, -5.73],
  [0.34, -5.73], [0.24, -5.7], [0.2, -5.58], [0.26, -5.42], [0.3, -5.2],
  [0.38, -5.0], [0.4, -4.5], [0.4, -3.9], [0.38, -3.3], [0.34, -2.95],
  [0.3, -2.4], [0.26, -1.9], [0.22, -1.55], [0.16, -1.36], [0, -1.3],
]

/** 人的轮廓：双臂、躯干连腿、头颈。坐标是「y 向上」的示意坐标。 */
function bodyMarkup() {
  const right = BODY_HALF
  const left = BODY_HALF.slice(0, -1).reverse().map(([x, y]) => [-x, y])
  const torso = smoothPath(right.concat(left), true)

  /* 胳膊沿 (cos72,-sin72) 方向伸下去，粗细从肩到指尖慢慢收。 */
  const armSegs = [[0, 0.22], [0.8, 0.19], [1.6, 0.165], [2.4, 0.14], [3.0, 0.12], [3.2, 0.125]]
  const tip = 0.1
  const end = 3.42
  const arm = (side) => {
    const dx = side * Math.cos(ARM)
    const dy = -Math.sin(ARM)
    const nx = -dy
    const ny = dx
    const outer = []
    const inner = []
    for (const [t, w] of armSegs) {
      const cx = side * SH_X + dx * t
      const cy = SH_Y + dy * t
      outer.push([cx + nx * w, cy + ny * w])
      inner.push([cx - nx * w, cy - ny * w])
    }
    /* 指尖画个半圆，别是尖的。 */
    const tipX = side * SH_X + dx * end
    const tipY = SH_Y + dy * end
    const arc = []
    for (let i = 1; i < 6; i++) {
      const a = (i / 6) * Math.PI
      arc.push([tipX + nx * tip * Math.cos(a) + dx * tip * Math.sin(a), tipY + ny * tip * Math.cos(a) + dy * tip * Math.sin(a)])
    }
    return smoothPath(outer.concat(arc, inner.reverse()), true)
  }

  return [
    '<g fill="#f6efe4" stroke="#c2b09a" stroke-width="1.1" stroke-linejoin="round">',
    `<path vector-effect="non-scaling-stroke" d="${arm(1)}"/>`,
    `<path vector-effect="non-scaling-stroke" d="${arm(-1)}"/>`,
    `<path vector-effect="non-scaling-stroke" d="${torso}"/>`,
    /* 脖子只给两边的线，横边由躯干挡住，不然肩上会多一道横线。 */
    '<path vector-effect="non-scaling-stroke" d="M-0.2,1.84 L-0.17,2.22 M0.2,1.84 L0.17,2.22" fill="none"/>',
    '<ellipse vector-effect="non-scaling-stroke" cx="0" cy="2.57" rx="0.34" ry="0.46"/>',
    '</g>',
  ].join('')
}

/** 同一条经上、当前这一面看得见的穴连成虚线，给出循行的大致样子。 */
function meridianMarkup(point, view) {
  const same = DATA.points
    .filter((one) => one.mi === point.mi)
    .sort((a, b) => Number(a.id) - Number(b.id))
  const runs = []
  let run = []
  let last = null
  for (const one of same) {
    if (viewOf(one) !== view) {
      if (run.length > 1) runs.push(run)
      run = []
      last = null
      continue
    }
    const p = project(one)
    const x = view === 'back' ? -p.x : p.x
    if (last && Math.hypot(x - last.x, p.y - last.y) > 1.2) {
      if (run.length > 1) runs.push(run)
      run = []
    }
    run.push({ x, y: p.y })
    last = { x, y: p.y }
  }
  if (run.length > 1) runs.push(run)
  return runs
    .map((one) => `<path d="${one.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)},${n(p.y)}`).join('')}" fill="none" stroke="#c98f56" stroke-width="1.3" stroke-dasharray="3 2.4" opacity="0.55" vector-effect="non-scaling-stroke"/>`)
    .join('')
}

/** 全部穴位的小点，标出这一面看得见的位置；双侧穴镜像补另一边。 */
function dotsMarkup(view, onlyMi) {
  const out = []
  for (const one of DATA.points) {
    if (viewOf(one) !== view) continue
    if (onlyMi !== undefined && one.mi !== onlyMi) continue
    const p = project(one)
    const x = view === 'back' ? -p.x : p.x
    const size = onlyMi === undefined ? '0.03' : '0.034'
    out.push(`<circle cx="${n(x)}" cy="${n(p.y)}" r="${size}" fill="#b07a45" opacity="0.5"/>`)
    if (Math.abs(x) >= 0.15) out.push(`<circle cx="${n(-x)}" cy="${n(p.y)}" r="${size}" fill="#b07a45" opacity="0.5"/>`)
  }
  return out.join('')
}

/** 目标穴：红圈 + 红点。 */
function markMarkup(x, y, r) {
  return (
    `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="none" stroke="#c0392b" stroke-width="1.6" vector-effect="non-scaling-stroke" opacity="0.55"/>` +
    `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.3)}" fill="#c0392b"/>`
  )
}

/**
 * 画一张穴位示意图。
 * @param {object} point 穴位数据
 * @returns {string} 完整 SVG 文本
 */
export function acupointSvg(point) {
  const view = viewOf(point)
  const center = project(point)
  const radius = REGION_R[regionOf(point.pos)] || 0.5
  const s2 = ZOOM_R / radius
  const px = view === 'back' ? -center.x : center.x
  const py = center.y

  const body = bodyMarkup()
  const meridian = meridianMarkup(point, view)
  const content = body + meridian + dotsMarkup(view)
  /* 放大图里只点同一条经的穴，免得满屏小点看不出重点。 */
  const zoomContent = body + meridian + dotsMarkup(view, point.mi)

  const bodyGroup = `<g transform="translate(${BODY_CX},${n(BODY_CY + Y_MID * BODY_S)}) scale(${BODY_S},${-BODY_S})">${content}</g>`
  const zoomGroup = `<g clip-path="url(#zc)"><g transform="translate(${ZOOM_CX},${ZOOM_CY}) scale(${n(s2)},${n(-s2)}) translate(${n(-px)},${n(-py)})">${zoomContent}${markMarkup(px, py, 0.16)}</g></g>`

  /* 小图上的红圈。 */
  const miniMark = `<g transform="translate(${BODY_CX},${n(BODY_CY + Y_MID * BODY_S)}) scale(${BODY_S},${-BODY_S})">${markMarkup(px, py, 0.18)}</g>`

  /* 放大圆里的穴名：压在图上，白色描边托底，不糊。 */
  const label = [
    `<line x1="0.08" y1="0.1" x2="0.19" y2="0.26" stroke="#8a6a4a" stroke-width="1" opacity="0.6" vector-effect="non-scaling-stroke"/>`,
    `<text x="0.2" y="0.3" font-size="0.086" fill="#4a3a2a" stroke="#fffdf8" stroke-width="0.02" paint-order="stroke" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif">${escapeXml(point.name)}</text>`,
  ].join('')
  const labelGroup = `<g transform="translate(${ZOOM_CX},${ZOOM_CY}) scale(${n(s2)},${n(s2)})">${label}</g>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(point.name)}穴位示意图">`,
    '<defs>',
    `<clipPath id="zc"><circle cx="${ZOOM_CX}" cy="${ZOOM_CY}" r="${ZOOM_R - 1}"/></clipPath>`,
    '</defs>',
    `<text x="${BODY_CX}" y="34" font-size="11" fill="#8a7a68" text-anchor="middle" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif">${view === 'back' ? '背面' : '正面'}</text>`,
    bodyGroup,
    miniMark,
    `<circle cx="${ZOOM_CX}" cy="${ZOOM_CY}" r="${ZOOM_R}" fill="none" stroke="#d8c8b4" stroke-width="1"/>`,
    zoomGroup,
    labelGroup,
    `<text x="${W / 2}" y="${H - 8}" font-size="9" fill="#8a7a68" text-anchor="middle" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif">示意图 · 腧穴定位据 GB/T 12346—2021</text>`,
    '</svg>',
  ].join('')
}

/** SVG 里的文字要转义。 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ── 通道 ── */

/**
 * 挂上穴位图通道：/dsh-tcm-xueli/acupoint/<编号>.svg。
 * 只发本插件自己画的图，只认本机页面，只认 GET。
 * @param {object} ctx
 * @param {{path?: string, log?: string}} [options]
 * @returns {Promise<() => void>}
 */
export async function mountAcupointRoute(ctx, options = {}) {
  const log = options.log || '[穴位图]'
  /* 前缀路由的键不能带结尾斜杠：Web 服务按「等于前缀或以 前缀/ 开头」匹配，
     带斜杠的话 /acupoint/67.svg 反而匹配不上（踩过的坑）。 */
  const prefix = (options.path || ACUPOINT_PREFIX).replace(/\/+$/, '')

  let webServer = ctx.get ? ctx.get('webServer') : undefined
  for (let i = 0; i < 20 && (!webServer || typeof webServer.register !== 'function'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    webServer = ctx.get ? ctx.get('webServer') : undefined
  }
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('这台 DSH 没有 Web 服务，穴位图画不出来')
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      if (!fromThisMachine(req)) {
        res.writeHead(403)
        res.end()
        return
      }
      let name = ''
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        name = decodeURIComponent(url.pathname.slice(prefix.length + 1))
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const matched = /^(\d+)\.svg$/.exec(name)
      if (!matched) {
        res.writeHead(404)
        res.end()
        return
      }
      const point = DATA.points.find((one) => String(one.id) === matched[1])
      if (!point) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const body = Buffer.from(acupointSvg(point), 'utf8')
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          'content-length': body.length,
        })
        res.end(body)
      } catch (error) {
        ctx.logger?.warn?.(log + '画图出错：' + String(error && error.message ? error.message : error))
        res.writeHead(500)
        res.end()
      }
    },
  })

  ctx.logger?.info?.(log + '通道已开：' + prefix + '/')
  return () => {
    try {
      dispose?.()
    } catch (error) {
      ctx.logger?.warn?.(log + '关闭通道出错：' + String(error && error.message ? error.message : error))
    }
  }
}