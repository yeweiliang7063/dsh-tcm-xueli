import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ART_DIR, ART_FILES, ART_PREFIX, artUrl, mountArtRoute } from '../lib/artwork.js'

test('面板插图：白名单里的图都在盘上，地址对得上', () => {
  const names = Object.keys(ART_FILES)
  assert.ok(names.length >= 1, '至少一张小像')
  for (const name of names) {
    const file = path.join(ART_DIR, name)
    assert.ok(fs.existsSync(file), name + ' 要随包带上')
    assert.ok(fs.statSync(file).size > 1024, name + ' 不该是空文件')
    assert.equal(artUrl(name), ART_PREFIX + name)
  }
})

const ask = (route, req) => new Promise((resolve) => {
  const res = {
    code: 0,
    body: '',
    headers: {},
    writeHead(code, headers) { this.code = code; this.headers = headers || {} },
    end(body) { this.body = body || ''; resolve(this) },
  }
  route.handler(req, res)
})

const local = (url, method = 'GET') => ({ method, url, headers: { host: '127.0.0.1:59174' }, socket: { remoteAddress: '127.0.0.1' } })

test('插图通道：白名单照发；没在白名单、非 GET、外地连接都挡住', async () => {
  let route = null
  const ctx = {
    get: (key) => (key === 'webServer' ? { register: (r) => { route = r; return () => { route = null } } } : undefined),
    logger: { info() {}, warn() {} },
  }
  const dispose = await mountArtRoute(ctx, {})
  try {
    assert.ok(route, '要在 Web 服务上注册一条路由')
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, ART_PREFIX.replace(/\/+$/, ''), '前缀不能带结尾斜杠')
    assert.ok((ART_PREFIX + 'laoyi.png').startsWith(route.path + '/'), '按 Web 服务的匹配规则算得上：等于前缀或以「前缀/」开头')

    const hit = await ask(route, local(ART_PREFIX + 'laoyi.png'))
    assert.equal(hit.code, 200)
    assert.equal(hit.headers['content-type'], 'image/png')
    assert.ok(hit.body.length > 1024, '要真的把图发出去')
    assert.ok(String(hit.headers['cache-control']).includes('max-age'))

    assert.equal((await ask(route, local(ART_PREFIX + 'nope.png'))).code, 404, '没在白名单不发')
    assert.equal((await ask(route, local(ART_PREFIX + '../laoyi.png'))).code, 404, '不许目录穿越')
    assert.equal((await ask(route, local(ART_PREFIX + 'laoyi.png', 'POST'))).code, 405)
    const remote = await ask(route, {
      method: 'GET',
      url: ART_PREFIX + 'laoyi.png',
      headers: { host: '127.0.0.1:1' },
      socket: { remoteAddress: '8.8.8.8' },
    })
    assert.equal(remote.code, 403, '外地连接不给看')
  } finally {
    dispose()
    assert.equal(route, null, '卸载时要把路由摘掉')
  }
})