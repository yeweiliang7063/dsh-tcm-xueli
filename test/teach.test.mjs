// 本插件的真删通道：删本插件预设开的、非模拟问诊的那一局（答疑局＋普通学习版局）；
// 模拟问诊局、别的预设、别的路径、别的机器，一律不许碰。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isOwnSession, mountTeachRoute, ownsSession, teachMetaOf, TEACH_TITLE } from '../lib/teach.js'

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-teach-'))
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  return home
}

function putMeta(home, id, title, preset) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', id + '.json')
  const doc = { version: 7, record: { rows: { title: { ver: 1, seq: 1, val: title }, agentPreset: { ver: 1, seq: 1, val: preset } } } }
  writeFileSync(file, JSON.stringify(doc), 'utf8')
}

test('标题与预设读得出来；文件不在、JSON 坏了都返回 null', () => {
  const home = makeHome()
  putMeta(home, 'session-a', TEACH_TITLE + '桂枝汤', 'dsh-tcm-xueli')
  assert.deepEqual(teachMetaOf('session-a', home), { title: TEACH_TITLE + '桂枝汤', preset: 'dsh-tcm-xueli' })
  assert.equal(teachMetaOf('session-missing', home), null)
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-bad.json'), '{坏的', 'utf8')
  assert.equal(teachMetaOf('session-bad', home), null)
  assert.equal(teachMetaOf('../../等等', home), null, '会话号里有路径符号的一律不认')
})

test('认本插件预设的非模拟局：答疑局与普通学习版局能删，模拟局与别的预设不许', () => {
  const home = makeHome()
  putMeta(home, 'session-ok', TEACH_TITLE + '太阳表虚', 'dsh-tcm-xueli')
  putMeta(home, 'session-regular', '桂枝汤学习', 'dsh-tcm-xueli')
  putMeta(home, 'session-other', '答疑·别人的', 'cordis')
  putMeta(home, 'session-plain', '问诊·局一', 'dsh-tcm-xueli')
  assert.equal(isOwnSession('session-ok', home), true)
  assert.equal(isOwnSession('session-regular', home), true, '学习版面板的普通局（工作台真删按钮）也能从这条通道删')
  assert.equal(isOwnSession('session-other', home), false, '别的预设的局不许删')
  assert.equal(isOwnSession('session-plain', home), false, '模拟问诊局走 sim-end 自己的通道，不许从这条删')
  assert.equal(isOwnSession('session-none', home), false)
})

/** 假 Web 服务：只记下注册进来的处理器，方便直接调用。 */
function fakeWeb() {
  const routes = []
  return {
    register(options) {
      routes.push(options)
      return () => {}
    },
    routes,
  }
}

function fakeReq(method, url, remoteAddress = '127.0.0.1', extraHeaders = {}) {
  return { method, url, headers: { host: '127.0.0.1:64368', 'sec-fetch-site': 'same-origin', ...extraHeaders }, socket: { remoteAddress, localAddress: '127.0.0.1' } }
}

function fakeRes() {
  const out = { code: 0, body: '' }
  return {
    out,
    writeHead(code) { out.code = code },
    end(body) { if (body) out.body = body },
  }
}

test('删除通道：不认的局、错的动作用都会被挡回来', async () => {
  const home = makeHome()
  putMeta(home, 'session-ok', TEACH_TITLE + '一问', 'dsh-tcm-xueli')
  putMeta(home, 'session-other', '答疑·别人的', 'cordis')
  const web = fakeWeb()
  let purged = null
  const dispose = await mountTeachRoute({ get: (name) => (name === 'webServer' ? web : undefined) }, {
    owns: (id) => isOwnSession(id, home),
    purge: (id) => { purged = id; return { ok: true, removed: ['/x/' + id] } },
  })
  assert.equal(typeof dispose, 'function', '挂上要能卸掉')
  assert.equal(web.routes.length, 1)
  const handler = web.routes[0].handler

  const cases = [
    [fakeReq('POST', '/dsh-tcm-xueli/teach-end?doing=delete&session=session-ok'), 405],
    [fakeReq('GET', '/dsh-tcm-xueli/teach-end?doing=delete&session=session-other'), 403],
    [fakeReq('GET', '/dsh-tcm-xueli/teach-end?doing=delete&session=session-none'), 403],
    [fakeReq('GET', '/dsh-tcm-xueli/teach-end?doing=archive&session=session-ok'), 400],
    [fakeReq('GET', '/dsh-tcm-xueli/teach-end?doing=delete&session=../../etc'), 400],
    [fakeReq('GET', '/dsh-tcm-xueli/teach-end?doing=delete&session=session-ok', '10.0.0.7'), 403],
  ]
  for (const [req, code] of cases) {
    const res = fakeRes()
    handler(req, res)
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(res.out.code, code, '这一请求的返回码不对：' + req.url)
    if (code !== 405) assert.equal(JSON.parse(res.out.body).ok, false)
  }
  assert.equal(purged, null, '被挡回来的请求一个都不许真删')
})

test('删除通道：认的那一局交给 purge 真删', async () => {
  const home = makeHome()
  putMeta(home, 'session-ok', TEACH_TITLE + '一问', 'dsh-tcm-xueli')
  const web = fakeWeb()
  const seen = []
  await mountTeachRoute({ get: (name) => (name === 'webServer' ? web : undefined) }, {
    owns: (id) => isOwnSession(id, home),
    purge: async (id) => { seen.push(id); return { ok: true, removed: ['/x/' + id] } },
  })
  const res = fakeRes()
  web.routes[0].handler(fakeReq('GET', '/dsh-tcm-xueli/teach-end?doing=delete&session=session-ok'), res)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(seen, ['session-ok'])
  assert.equal(res.out.code, 200)
  assert.equal(JSON.parse(res.out.body).ok, true)
})

test('认人：缓存还没落盘的这一局，改问宿主预设与标题，两样都对才认', async () => {
  const home = makeHome()
  // 正在用的那一局，投影缓存文件还不在——这就是真机上「说不是讲解答疑开的」那种情形。
  assert.equal(isOwnSession('session-live', home), false)
  const seen = []
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async observeSession(id) {
            seen.push(id)
            return { projections: { values: { agentPreset: 'dsh-tcm-xueli', title: TEACH_TITLE + '一问' } } }
          },
        }
      }
      return undefined
    },
  }
  assert.equal(await ownsSession(ctx, 'session-live', home), true, '宿主说是答疑局，就得认')
  assert.deepEqual(seen, ['session-live'])
  const other = {
    get: () => ({ async observeSession() { return { projections: { values: { agentPreset: 'cordis', title: TEACH_TITLE + '一问' } } } } }),
  }
  assert.equal(await ownsSession(other, 'session-live', home), false, '别的预设一律不认')
  const sim = {
    get: () => ({ async observeSession() { return { projections: { values: { agentPreset: 'dsh-tcm-xueli', title: '问诊·局 20261123-1（普通·方药）' } } } } }),
  }
  assert.equal(await ownsSession(sim, 'session-live', home), false, '同预设的模拟问诊局也不许从这条通道删')
  const regular = {
    get: () => ({ async observeSession() { return { projections: { values: { agentPreset: 'dsh-tcm-xueli', title: '桂枝汤学习' } } } } }),
  }
  assert.equal(await ownsSession(regular, 'session-live', home), true, '本插件预设的普通学习版局（工作台真删）也认')
  const noTitle = {
    get: () => ({ async observeSession() { return { projections: { values: { agentPreset: 'dsh-tcm-xueli' } } } } }),
  }
  assert.equal(await ownsSession(noTitle, 'session-live', home), false, '标题读不出来就认不出（没法排除是模拟局），宁可不删')
  const broken = { get: () => ({ async observeSession() { throw new Error('查不到') } }) }
  assert.equal(await ownsSession(broken, 'session-live', home), false, '查不出来就当不是自己的')
  assert.equal(await ownsSession({ get: () => undefined }, 'session-live', home), false)
})

test('删除通道：缓存里没有、宿主认得的这一局也能删', async () => {
  const home = makeHome()
  const web = fakeWeb()
  let purged = null
  const ctx = {
    get(name) {
      if (name === 'webServer') return web
      if (name === 'sessionQuery') {
        return { async observeSession() { return { projections: { values: { agentPreset: 'dsh-tcm-xueli', title: TEACH_TITLE + '一问' } } } } }
      }
      return undefined
    },
  }
  await mountTeachRoute(ctx, {
    owns: (id) => ownsSession(ctx, id, home),
    purge: (id) => { purged = id; return { ok: true, removed: [] } },
  })
  const res = fakeRes()
  web.routes[0].handler(fakeReq('GET', '/dsh-tcm-xueli/teach-end?doing=delete&session=session-live'), res)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(purged, 'session-live')
  assert.equal(res.out.code, 200)
})

test('删除通道防 CSRF：外站 Origin／Referer 一律拒，本机页面与同源 Fetch Metadata 才放行', async () => {
  const home = makeHome()
  putMeta(home, 'session-ok', TEACH_TITLE + '一问', 'dsh-tcm-xueli')
  const web = fakeWeb()
  const purged = []
  await mountTeachRoute({ get: (name) => (name === 'webServer' ? web : undefined) }, {
    owns: (id) => isOwnSession(id, home),
    purge: (id) => { purged.push(id); return { ok: true, removed: [] } },
  })
  const handler = web.routes[0].handler
  const ask = async (req) => {
    const res = fakeRes()
    handler(req, res)
    await new Promise((r) => setTimeout(r, 20))
    return res.out.code
  }
  const url = '/dsh-tcm-xueli/teach-end?doing=delete&session=session-ok'
  // 本机任意网页都能把请求打到回环地址：来源地址与 Host 都对，但页面是外站的。
  assert.equal(await ask(fakeReq('GET', url, '127.0.0.1', { origin: 'https://evil.example.com' })), 403, '外站 Origin 拒')
  assert.equal(await ask(fakeReq('GET', url, '127.0.0.1', { referer: 'https://evil.example.com/page.html' })), 403, '外站 Referer 拒')
  assert.equal(await ask(fakeReq('GET', url, '127.0.0.1', { origin: 'null' })), 403, '沙箱页的 null Origin 也拒')
  assert.equal(await ask(fakeReq('GET', url, '127.0.0.1', { origin: 'http://127.0.0.1:64368' })), 200, '同源 GUI 的 Origin 放行')
  assert.equal(await ask(fakeReq('GET', url, '127.0.0.1', { referer: 'http://127.0.0.1:64368/' })), 200, '同源 GUI 的 Referer 放行')
  assert.equal(await ask(fakeReq('GET', url, '127.0.0.1', { 'sec-fetch-site': 'same-origin' })), 200, '双缺＋同源 fetch 放行')
  assert.equal(await ask(fakeReq('GET', url, '8.8.8.8', { origin: 'http://127.0.0.1:64368' })), 403, '远程来源一律拒')
  assert.deepEqual(purged, ['session-ok', 'session-ok', 'session-ok'], '只有放行的那三次才真删')
})
