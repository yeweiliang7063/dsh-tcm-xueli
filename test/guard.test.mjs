// 统一门卫（lib/guard.js）：出向认会话、入向认本机与面板局。
// 这里只测判断本身与「判断接在通道上」的效果，不碰真会话、真目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGuard, fromLocalPage, fromThisMachine, ownPreset } from '../lib/guard.js'
import { addPending } from '../lib/purge.js'
import { mountSimEndRoute } from '../lib/sim-think.js'

// 测试绝不碰真东西：DSH_HOME 指到临时目录，待清名单是空的，删不到任何真会话。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'tcm-guard-test-'))
process.env.DSH_HOME = TEST_HOME
test.after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* 清不掉也不影响结论 */ }
})

/* ── 入向：本机判断（三条通道共用的那一份） ── */

const req = (remote, host) => ({ socket: { remoteAddress: remote }, headers: { host } })

test('本机判断：来源地址与 Host 头都对才放行', () => {
  assert.equal(fromThisMachine(req('127.0.0.1', '127.0.0.1:59174')), true)
  assert.equal(fromThisMachine(req('127.0.0.1', 'localhost:59174')), true)
  assert.equal(fromThisMachine(req('::1', '[::1]:59174')), true)
  assert.equal(fromThisMachine(req('::ffff:127.0.0.1', '127.0.0.1')), true)
})

test('本机判断：远程来源一律拒，Host 头伪造也救不回来', () => {
  assert.equal(fromThisMachine(req('8.8.8.8', '127.0.0.1:59174')), false, '来源是外网，Host 写成本机也没用')
  assert.equal(fromThisMachine(req('192.168.1.9', 'localhost')), false, '局域网别的机器不算本机')
  assert.equal(fromThisMachine(req('127.0.0.1', 'evil.example.com')), false, '来源对但 Host 不对也拒')
  assert.equal(fromThisMachine(req('127.0.0.1', '')), false, '没有 Host 头也拒')
  assert.equal(fromThisMachine(null), false, '空请求不抛错，直接拒')
  assert.equal(fromThisMachine({}), false)
})

/* ── 入向：本机页面判断（会改东西的通道专用，防本机 CSRF） ── */

const pageReq = (headers, remote = '127.0.0.1') => ({
  socket: { remoteAddress: remote },
  headers: { host: '127.0.0.1:59174', ...headers },
})

test('本机页面判断：外站 Origin／Referer 一律拒，哪怕连接就在本机', () => {
  assert.equal(fromLocalPage(pageReq({ origin: 'https://evil.example.com' })), false, 'evil Origin 拒')
  assert.equal(fromLocalPage(pageReq({ referer: 'https://evil.example.com/a.html' })), false, 'evil Referer 拒')
  assert.equal(fromLocalPage(pageReq({ origin: 'null' })), false, '沙箱页的 null Origin 拒')
  assert.equal(fromLocalPage(pageReq({ origin: 'file://' })), false, '本地文件页也拒')
  assert.equal(fromLocalPage(pageReq({ origin: 'http://127.0.0.1.evil.com' })), false, '长得像回环的域名拒')
  assert.equal(fromLocalPage(pageReq({ origin: 'http://192.168.1.9:59174' })), false, '局域网页面不算本机页面')
  assert.equal(fromLocalPage(pageReq({ origin: 'https://evil.example.com', referer: 'http://127.0.0.1:59174/' })), false, 'Origin 优先：外站 Origin 不被好 Referer 救回')
})

test('本机页面判断：同源 GUI 的 Origin／Referer 过，双缺也过', () => {
  assert.equal(fromLocalPage(pageReq({ origin: 'http://127.0.0.1:59174' })), true, 'GUI Origin 过')
  assert.equal(fromLocalPage(pageReq({ origin: 'http://localhost:59174' })), true)
  assert.equal(fromLocalPage(pageReq({ origin: 'http://[::1]:59174' })), true)
  assert.equal(fromLocalPage(pageReq({ referer: 'http://127.0.0.1:59174/' })), true, 'GUI Referer 过')
  assert.equal(fromLocalPage(pageReq({})), true, '双缺过')
  assert.equal(fromLocalPage(pageReq({ origin: '', referer: '' })), true, '空头按缺处理')
})

test('本机页面判断：远程连接先被本机判断挡下，页面头再像也没用', () => {
  assert.equal(fromLocalPage(pageReq({ origin: 'http://127.0.0.1:59174' }, '8.8.8.8')), false, '远程拒')
  assert.equal(fromLocalPage(pageReq({}, '192.168.1.9')), false)
  assert.equal(fromLocalPage(null), false, '空请求不抛错，直接拒')
})

/* ── 入向：面板局归属（删局、还档位、归档的闸） ── */

test('门卫默认拒：没人报面板局之前，什么请求都不动', () => {
  const guard = createGuard()
  assert.equal(guard.canRelease('s-any'), false)
  assert.equal(guard.canArchive('s-any'), false)
  assert.equal(guard.canPurge('s-any'), false)
  assert.equal(guard.canRelease(''), false, '空会话号也拒')
})

test('绑定认人函数后：只认面板开的局', () => {
  const guard = createGuard()
  const claimed = new Set(['s-panel'])
  guard.bindPanel((id) => claimed.has(id))
  assert.equal(guard.canRelease('s-panel'), true)
  assert.equal(guard.canArchive('s-panel'), true)
  assert.equal(guard.canPurge('s-panel'), true)
  assert.equal(guard.canRelease('s-handtyped'), false, '手打局不认')
  assert.equal(guard.canArchive('s-handtyped'), false)
  assert.equal(guard.canPurge('s-handtyped'), false)
})

test('认人函数抛错：按不是自己的处理，不向外抛', () => {
  const guard = createGuard()
  guard.bindPanel(() => { throw new Error('认人坏了') })
  assert.equal(guard.canRelease('s-panel'), false)
  assert.equal(guard.canPurge('s-panel'), false)
  guard.bindPanel('不是函数')
  assert.equal(guard.canRelease('s-panel'), false, '传进来的不是函数就当没报')
})

test('重启后面板补删也认：待清名单上的局可以删，但还档位仍只认内存登记', () => {
  const guard = createGuard() // 新实例＝重启后，内存登记是空的
  addPending('s-ledger')
  assert.equal(guard.canPurge('s-ledger'), true, '名单上记的就是面板局，补删要认')
  assert.equal(guard.canRelease('s-ledger'), false, '还档位只认内存登记，名单不顶替')
  assert.equal(guard.canPurge('s-not-listed'), false)
})

/* ── 出向：归档闸（只认本插件预设及旧版别名） ── */

test('归档闸：当前预设优先，读不到退回创建时的预设', () => {
  const currentPreset = (session) => session.projectionPreset
  const tcm = { header: { agentPreset: 'dsh-tcm-xueli' } }
  const other = { header: { agentPreset: 'cordis' } }
  const switched = { header: { agentPreset: 'cordis' }, projectionPreset: 'dsh-tcm-xueli' }
  assert.equal(ownPreset(tcm, { currentPreset }), true, '创建时就是本插件预设')
  assert.equal(ownPreset(other, { currentPreset }), false, '普通编码会话不归档')
  assert.equal(ownPreset(switched, { currentPreset }), true, '空白窗口换成本插件预设也要认')
})

test('归档闸：旧版别名认，抛错退回，两样都没有就拒', () => {
  assert.equal(ownPreset({ header: { agentPreset: 'tcm' } }, {}), true)
  assert.equal(ownPreset({ header: { agentPreset: 'dsh-tcm' } }, {}), true)
  const boom = () => { throw new Error('读预设坏了') }
  assert.equal(ownPreset({ header: { agentPreset: 'dsh-tcm-xueli' } }, { currentPreset: boom }), true, '抛错退回 header')
  assert.equal(ownPreset({ header: { agentPreset: 'cordis' } }, { currentPreset: boom }), false)
  assert.equal(ownPreset({}, {}), false, '什么都没有就不归档')
  assert.equal(ownPreset(null, {}), false)
})

/* ── 入向接线：弃局通道上，非面板局的请求动不了内部状态 ── */

test('弃局通道＋门卫：带个会话号进来，删不到也还原不了别的局', async () => {
  const guard = createGuard()
  const claimed = new Set(['s-panel'])
  guard.bindPanel((id) => claimed.has(id))
  const released = []
  const purged = []
  let route = null
  const ctx = {
    get: (key) => (key === 'webServer' ? { register: (r) => { route = r; return () => { route = null } } } : undefined),
    logger: { info() {}, warn() {} },
  }
  // 与 lib/sim.js 相同的接法：回调先过门卫再动内部状态。
  const dispose = await mountSimEndRoute(ctx, {
    release: (id) => { if (!guard.canRelease(id)) return; released.push(id) },
    purge: (id) => { if (!guard.canPurge(id)) return; purged.push(id) },
  })
  const ask = (url, remote = '127.0.0.1') => new Promise((resolve) => {
    const res = {
      code: 0,
      writeHead(c) { this.code = c },
      end() { resolve(this) },
    }
    route.handler({ method: 'GET', url, headers: { host: '127.0.0.1:59174' }, socket: { remoteAddress: remote } }, res)
  })

  const other = await ask('/dsh-tcm-xueli/sim-end?purge=1&session=s-other')
  assert.equal(other.code, 200, '通道本身照常应答，不给外面递话')
  assert.deepEqual(released, [], '别的会话：还原请求被门卫拒掉')
  assert.deepEqual(purged, [], '别的会话：删除请求同样被拒')

  await ask('/dsh-tcm-xueli/sim-end?purge=1&session=s-panel')
  assert.deepEqual(released, ['s-panel'], '面板局照常还原')
  assert.deepEqual(purged, ['s-panel'], '面板局照常删')

  const remote = await ask('/dsh-tcm-xueli/sim-end?purge=1&session=s-panel', '8.8.8.8')
  assert.equal(remote.code, 403, '远程伪造在本机判断那一关就被挡下')
  assert.deepEqual(released, ['s-panel'], '远程请求到不了内部功能')
  assert.deepEqual(purged, ['s-panel'])
  dispose()
})