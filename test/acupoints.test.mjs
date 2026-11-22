import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACUPOINTS, ACUPOINT_PREFIX, findAcupoint, acupointInfo, acupointSvg, regionOf, mountAcupointRoute } from '../lib/acupoints.js'

test('穴位表：三百六十一穴都读得进来，名字不重复', () => {
  assert.ok(ACUPOINTS.length >= 300, '数据要够全，实际 ' + ACUPOINTS.length + ' 穴')
  const names = new Set(ACUPOINTS.map((one) => one.name))
  assert.equal(names.size, ACUPOINTS.length, '穴名不该有重复')
  for (const one of ACUPOINTS) {
    assert.ok(one.id > 0 && one.name, '每个穴要有编号和名字')
    assert.ok(one.pos && Number.isFinite(one.pos.x) && Number.isFinite(one.pos.y), one.name + ' 要有坐标')
  }
})

test('查穴：正名、别名、拼音、带「穴」都能认出来，认不出就老实返回空', () => {
  assert.equal(findAcupoint('足三里')?.name, '足三里')
  assert.equal(findAcupoint('合谷')?.name, '合谷')
  assert.equal(findAcupoint('合谷穴')?.name, '合谷')
  assert.equal(findAcupoint('三里')?.name, '足三里', '古书只写「三里」，要按别名对上足三里')
  assert.equal(findAcupoint('虎口')?.name, '合谷')
  assert.equal(findAcupoint('绝骨')?.name, '悬钟')
  assert.equal(findAcupoint('人中')?.name, '水沟')
  assert.equal(findAcupoint('神阙')?.name, '神阙')
  assert.equal(findAcupoint('HEGU')?.name, '合谷', '拼音大写也要认')
  assert.equal(findAcupoint('足三里（左）')?.name, '足三里', '括注要去掉')
  assert.equal(findAcupoint('不是穴位'), null)
  assert.equal(findAcupoint(''), null)
})

test('穴位信息：带上图片地址与出处', () => {
  const info = acupointInfo(findAcupoint('合谷'))
  assert.equal(info.name, '合谷')
  assert.equal(info.meridian, '手阳明大肠经')
  assert.ok(info.location && info.location.length > 4, '要有定位文字')
  assert.ok(info.func, '要有主治')
  assert.equal(info.image, ACUPOINT_PREFIX + info.id + '.svg')
  assert.ok(info.source.includes('GB/T 12346'), '要标定位依据')
})

test('画图：出的是 SVG，带穴名、红圈和定位依据，不留 NaN', () => {
  const svg = acupointSvg(findAcupoint('足三里'))
  assert.ok(svg.startsWith('<svg'), '要以 svg 开头')
  assert.ok(svg.includes('足三里'), '图上要写穴名')
  assert.ok(svg.includes('#c0392b'), '目标穴要用红圈')
  assert.ok(svg.includes('GB/T 12346'), '要标定位依据')
  assert.ok(svg.includes('非缩放') === false)
  assert.equal(/NaN|undefined/.test(svg), false, '不许出现 NaN 或 undefined')
  const head = acupointSvg(findAcupoint('百会'))
  assert.ok(head.includes('背面'), '头顶的穴在背面那个视图上，要有「背面」字样')
})

test('分区：头、颈、手、臂、躯干、腿、脚都认得出来', () => {
  assert.equal(regionOf({ x: 0.126, y: 2.6, z: 0.1 }), 'head')
  assert.equal(regionOf({ x: 0.126, y: 2.0, z: 0.1 }), 'neck')
  assert.equal(regionOf({ x: 3.5, y: 1.4, z: 0 }), 'hand')
  assert.equal(regionOf({ x: 2.0, y: 1.4, z: 0 }), 'arm')
  assert.equal(regionOf({ x: 0.3, y: 0.0, z: 0.3 }), 'trunk')
  assert.equal(regionOf({ x: 0.5, y: -2.0, z: 0 }), 'thigh')
  assert.equal(regionOf({ x: 0.5, y: -4.0, z: 0 }), 'leg')
  assert.equal(regionOf({ x: 0.5, y: -5.5, z: 0 }), 'foot')
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

test('图片通道：按编号出图；坏编号、未知穴、非 GET、外地连接都挡住', async () => {
  let route = null
  const ctx = {
    get: (key) => (key === 'webServer' ? { register: (r) => { route = r; return () => { route = null } } } : undefined),
    logger: { info() {}, warn() {} },
  }
  const dispose = await mountAcupointRoute(ctx, {})
  try {
    assert.ok(route, '要在 Web 服务上注册一条路由')
    assert.equal(route.kind, 'prefix', '一条前缀路由管全部穴，不要一穴一条')
    assert.equal(route.path, ACUPOINT_PREFIX.replace(/\/+$/, ''), '前缀不能带结尾斜杠')
    assert.ok((ACUPOINT_PREFIX + '1.svg').startsWith(route.path + '/'), '按 Web 服务的匹配规则算得上')

    const some = ACUPOINTS[0]
    const hit = await ask(route, local('/dsh-tcm-xueli/acupoint/' + some.id + '.svg'))
    assert.equal(hit.code, 200)
    assert.ok(String(hit.headers['content-type']).includes('image/svg+xml'))
    assert.ok(String(hit.body).includes('<svg'))

    assert.equal((await ask(route, local('/dsh-tcm-xueli/acupoint/abc.svg'))).code, 404)
    assert.equal((await ask(route, local('/dsh-tcm-xueli/acupoint/99999.svg'))).code, 404)
    assert.equal((await ask(route, local('/dsh-tcm-xueli/acupoint/1.txt'))).code, 404)
    assert.equal((await ask(route, local('/dsh-tcm-xueli/acupoint/' + some.id + '.svg', 'POST'))).code, 405)
    const remote = await ask(route, {
      method: 'GET',
      url: '/dsh-tcm-xueli/acupoint/' + some.id + '.svg',
      headers: { host: '127.0.0.1:1' },
      socket: { remoteAddress: '8.8.8.8' },
    })
    assert.equal(remote.code, 403, '外地连接不给看')
  } finally {
    dispose()
    assert.equal(route, null, '卸载时要把路由摘掉')
  }
})