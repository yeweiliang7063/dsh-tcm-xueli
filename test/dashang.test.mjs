import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountDashangRoute, DASHANG_FILES, DASHANG_PREFIX, DASHANG_TIP, dashangBlock, dashangHandler, dashangImageUrl, hasGiftSign, missingDisclaimer, DISCLAIMER, DASHANG_QR } from '../lib/dashang.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 喂一次假请求，回 { code, body, headers }。 */
function call(url, { method = 'GET', remote = '127.0.0.1', host = '127.0.0.1:59174' } = {}) {
  return new Promise((resolve) => {
    const out = { code: 0, body: '', headers: {} }
    const res = {
      writeHead(code, headers) { out.code = code; Object.assign(out.headers, headers || {}) },
      end(body) { out.body = body === undefined ? '' : body; resolve(out) },
    }
    dashangHandler({ method, url, headers: { host }, socket: { remoteAddress: remote } }, res)
  })
}

/** 装一次通道，拿到注册出来的路由。 */
async function mount() {
  const routes = []
  const ctx = {
    get: (key) => (key === 'webServer'
      ? { register: (r) => { routes.push(r); return () => { routes.splice(routes.indexOf(r), 1) } } }
      : undefined),
    logger: { info() {}, warn() {} },
  }
  const dispose = await mountDashangRoute(ctx)
  return { routes, dispose }
}

test('打赏码：拼好的一张加两张裁图都在包里，格式对得上', () => {
  assert.deepEqual(DASHANG_FILES, ['dashang-qr.png', 'alipay-qr.jpg', 'wechat-qr.jpg'])
  for (const name of DASHANG_FILES) {
    const file = path.join(ROOT, 'assets', 'dashang', name)
    assert.ok(fs.existsSync(file), `缺图：${file}`)
    const head = fs.readFileSync(file).subarray(0, 8)
    if (name.endsWith('.png')) {
      assert.deepEqual([...head.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${name} 不是 PNG`)
    } else {
      assert.equal(head[0], 0xff, `${name} 不是 JPG`)
      assert.equal(head[1], 0xd8, `${name} 不是 JPG`)
    }
  }
})

test('打赏码：每张图一条固定路由，地址与提示词里的图片地址一致', async () => {
  const { routes, dispose } = await mount()
  assert.equal(routes.length, DASHANG_FILES.length)
  assert.deepEqual(routes.map((r) => r.path).sort(), DASHANG_FILES.map((n) => DASHANG_PREFIX + n).sort())
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
  dispose()
  assert.equal(routes.length, 0, '关掉后路由要摘掉')
})

test('打赏码：本机 GET 回图，字节与源文件一致，类型按文件头认；HEAD 只回头不回身', async () => {
  for (const name of DASHANG_FILES) {
    const got = await call(DASHANG_PREFIX + name)
    assert.equal(got.code, 200)
    const source = fs.readFileSync(path.join(ROOT, 'assets', 'dashang', name))
    // PNG 魔数 89 50 4E 47 开头就发 image/png，其余按 JPEG——不许把 PNG 也说成 JPEG。
    const wantType = source[0] === 0x89 && source[1] === 0x50 && source[2] === 0x4e && source[3] === 0x47 ? 'image/png' : 'image/jpeg'
    assert.equal(got.headers['content-type'], wantType, `${name} 的 content-type 要与文件头一致`)
    assert.equal(Buffer.byteLength(got.body), source.length)
    assert.ok(Buffer.from(got.body).equals(source), `${name} 字节不一致`)

    const head = await call(DASHANG_PREFIX + name, { method: 'HEAD' })
    assert.equal(head.code, 200)
    assert.equal(head.headers['content-type'], wantType)
    assert.equal(head.body, '')
  }
})

test('打赏码：陌生文件名、目录穿越都回 404，不泄露目录', async () => {
  for (const url of [
    DASHANG_PREFIX + 'tupian.jpg',
    DASHANG_PREFIX + '..%2F..%2Fpackage.json',
    DASHANG_PREFIX + '',
    DASHANG_PREFIX,
  ]) {
    const got = await call(url)
    assert.equal(got.code, 404, url)
    assert.ok(!String(got.body).includes('alipay'), url)
  }
})

test('打赏码：非本机来源回 403，别的写法回 405', async () => {
  const remote = await call(DASHANG_PREFIX + DASHANG_QR, { remote: '192.168.1.7' })
  assert.equal(remote.code, 403)
  const foreignHost = await call(DASHANG_PREFIX + DASHANG_QR, { host: 'evil.example.com' })
  assert.equal(foreignHost.code, 403)
  const post = await call(DASHANG_PREFIX + DASHANG_QR, { method: 'POST' })
  assert.equal(post.code, 405)
})

test('打赏区：图片用插件安装位置现算的绝对路径，不写死也不拼端口', () => {
  const url = dashangImageUrl(DASHANG_QR)
  assert.ok(path.isAbsolute(url), '要是绝对路径：' + url)
  assert.ok(url.endsWith('/assets/dashang/dashang-qr.png'), '指到随包的那张拼图：' + url)
  assert.ok(!url.includes('127.0.0.1'), '不许写死本机地址')
  assert.ok(!url.includes(':59'), '不许带端口')
  assert.equal(dashangImageUrl('tupian.jpg'), '')
})

test('打赏区：分隔线、标题、一张拼好的码、自愿说明都在', () => {
  const text = dashangBlock()
  assert.ok(text.startsWith('---'))
  assert.ok(text.includes(DASHANG_TIP))
  assert.equal(text.split('![').length - 1, 1, '就一张：左右并排的那张')
  assert.ok(text.includes('支付宝（左）与微信（右）打赏码'), '图上要写明谁在左谁在右')
  assert.ok(text.includes('打赏全凭自愿'))
  assert.ok(!text.includes('http://'), '不再走网址')
})

test('打赏区：满十局时多一句「判完几局」，平常不加', () => {
  const plain = dashangBlock()
  assert.ok(!plain.includes('判完'), '平常不加局数那句')
  const full = dashangBlock(20)
  assert.ok(full.includes('（十局一摆：模拟问诊到这里已经判完 20 局。）'))
  assert.equal(dashangBlock(0), plain, '0 局等于平常')
})

test('打赏区：只看末尾那两句声明，出任意一句就补', () => {
  const sign1 = '【中医 · 经方（学习版）】本节仅供学习研究，不构成诊疗建议；如需用药或施针请由执业中医师面诊。'
  const sign2 = '⚠️ AI 有幻觉：以上内容由人工智能生成，可能编造原文、记错条文或张冠李戴，请自行核对原书后再用。'
  assert.equal(hasGiftSign(sign1), true, '第一句声明就算')
  assert.equal(hasGiftSign(sign2), true, '第二句声明也算')
  const both = '前面的正文很长。' + sign1 + sign2
  assert.equal(hasGiftSign(both), true, '夹在正文里也认')
  assert.equal(hasGiftSign('## 一、结论'), false, '光给分析、没声明就不补')
  assert.equal(hasGiftSign('## 手上的线索'), false, '问诊轮没有声明，不补')
  assert.equal(hasGiftSign(''), false)
  assert.equal(hasGiftSign(undefined), false)
})


test('免责声明：漏哪行补哪行，一行都不许少', () => {
  const [first, second] = DISCLAIMER.map((item) => item.line)
  assert.equal(DISCLAIMER.length, 2, '就这两行')
  assert.deepEqual(missingDisclaimer(''), [first, second], '一行没写，两行都补')
  assert.deepEqual(missingDisclaimer('正文。' + first), [second], '只写了第一行，补第二行')
  assert.deepEqual(missingDisclaimer('正文。' + second), [first], '只写了第二行，补第一行')
  assert.deepEqual(missingDisclaimer(first + second), [], '两行都写了，不再重复')
  assert.ok(first.includes('本节仅供学习研究') && first.includes('不构成诊疗建议'), '第一行原话')
  assert.ok(second.includes('AI 有幻觉') && second.includes('请自行核对原书后再用'), '第二行原话')
})
