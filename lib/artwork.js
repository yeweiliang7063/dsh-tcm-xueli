/**
 * 学习版 · 面板小图
 *
 * 「讲解答疑」头上那张老先生的小像，是一张随包的位图（assets/img/laoyi.png）。
 * 面板在 DSH 自己的网页里，图片得由宿主发出去，所以这里挂一条只读的图片通道：
 * /dsh-tcm-xueli/img/<文件名>。只发白名单里的文件，路径按 basename 取，防目录穿越。
 *
 * 整段出错只等于小像不显示，不影响面板和主体启动。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromThisMachine } from './guard.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 面板插图目录。 */
export const ART_DIR = path.join(HERE, '..', 'assets', 'img')
/** 插图通道：/dsh-tcm-xueli/img/<文件名> */
export const ART_PREFIX = '/dsh-tcm-xueli/img/'

/** 白名单：只发这几张，别的名字一律 404。 */
export const ART_FILES = {
  'laoyi.png': 'image/png',
}

/** 拼一张插图的地址，给面板直接当 <img src> 用。 */
export function artUrl(name) {
  return ART_PREFIX + name
}

/**
 * 挂图片通道。
 * @param {any} ctx 插件作用域
 * @param {{path?: string, log?: string}} [options]
 * @returns {Promise<() => void>} 卸载函数
 */
export async function mountArtRoute(ctx, options = {}) {
  const log = options.log || '[面板插图]'
  /* 前缀路由的键不能带结尾斜杠（见 acupoints.js 同一处注释）。 */
  const prefix = (options.path || ART_PREFIX).replace(/\/+$/, '')

  let webServer = ctx.get ? ctx.get('webServer') : undefined
  for (let i = 0; i < 20 && (!webServer || typeof webServer.register !== 'function'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    webServer = ctx.get ? ctx.get('webServer') : undefined
  }
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('这台 DSH 没有 Web 服务，面板插图画不出来')
  }

  /** 读过的图放内存，一张几十 KB，没必要每次重读。 */
  const cache = new Map()

  function readArt(name) {
    if (cache.has(name)) return cache.get(name)
    const file = path.join(ART_DIR, path.basename(name))
    const body = fs.readFileSync(file)
    cache.set(name, body)
    return body
  }

  ctx.logger?.info?.(log + '通道已开：' + prefix + '/')

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
      const type = ART_FILES[path.basename(name)]
      if (!type || name !== path.basename(name)) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const body = readArt(name)
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'public, max-age=86400',
          'content-length': body.length,
        })
        res.end(body)
      } catch (error) {
        ctx.logger?.warn?.(log + '发图出错：' + String(error && error.message ? error.message : error))
        res.writeHead(500)
        res.end()
      }
    },
  })

  return typeof dispose === 'function' ? dispose : () => {}
}