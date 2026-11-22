// 两块功能用代码隔离：经方学习版（lib/xuexi.js）与模拟问诊（lib/sim.js）各管各的，
// 改一块不碰坏另一块，一块出错也不拖累另一块。
//
// 这里查四件事：
//   1. 两个文件互不 import，谁缺了对方都能单独加载；
//   2. lib/index.js 只做组装，不管剂量也不管病例卡；
//   3. 组装出来的出口包装器真能把两块串起来（剂量照遮、打赏块编号还是一整块）；
//   4. 一块在流里抛错，回答照样往下走，另一块不受影响。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 装成中医会话：提示词里带预设名，出口那一层才认得出该遮剂量。 */
const TCM_SYSTEM = '预设：中医 · 经方（学习版）'
const PLUGIN = join(import.meta.dirname, '..')
const read = (name) => readFileSync(join(PLUGIN, 'lib', name), 'utf8')

test('隔离：两个功能文件互不引用', () => {
  const xuexi = read('xuexi.js')
  const sim = read('sim.js')
  assert.ok(!xuexi.includes("'./sim.js'"), '学习版不该引用模拟问诊')
  assert.ok(!sim.includes("'./xuexi.js'"), '模拟问诊不该引用学习版')
  assert.ok(!xuexi.includes('registerClinicTools'), '学习版不该管病例卡工具')
  assert.ok(!sim.includes('blotDosage'), '模拟问诊不该管剂量遮挡')
})

test('隔离：两个文件各自能单独加载', async () => {
  const xuexi = await import('../lib/xuexi.js')
  const sim = await import('../lib/sim.js')
  assert.equal(typeof xuexi.applyXuexi, 'function')
  assert.equal(typeof xuexi.currentPath, 'function')
  assert.equal(typeof sim.applySim, 'function')
  assert.equal(sim.applyXuexi, undefined, '模拟问诊那边不该捎带学习版的出口')
})

test('隔离：组装器只管组装', () => {
  const index = read('index.js')
  assert.ok(index.includes('applyXuexi') && index.includes('applySim'), '组装器要把两块都装上')
  assert.ok(!index.includes('hasDosage'), '剂量判定归学习版，组装器不许插手')
  assert.ok(!index.includes('registerClinicTools'), '病例卡工具归模拟问诊，组装器不许插手')
  // 两块各自包在自己的 try 里：一块装不上，另一块照装。
  assert.match(index, /try \{\s*xuexi = applyXuexi/)
  assert.match(index, /try \{\s*sim = applySim/)
})

/** 造一个只够装插件的假宿主：记下 llm/stream 的回调，别的服务一律没有。 */
function fakeCtx() {
  const handlers = []
  return {
    handlers,
    logger: { warn() {}, info() {} },
    on(event, fn) {
      if (event === 'llm/stream') handlers.push(fn)
      return () => {}
    },
    effect() {},
  }
}

test('隔离：宿主什么都没有也不抛，两块都跳过、出口照旧放行', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeCtx()
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(ctx.handlers.length, 1, '出口只许挂一次')

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '第一句。' },
    { type: 'finish', reason: 'stop' },
  ]
  const out = []
  for await (const c of ctx.handlers[0]({ sessionId: 's1', system: '' }, async function* () { for (const c of chunks) yield c })) out.push(c)
  assert.equal(out.length, chunks.length, '都不在场时原样放行')
})

test('隔离：串联之后剂量照遮、打赏块编号仍是连着的', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeCtx()
  apply(ctx, { kbPath: 'D:/中医知识库' })
  const handler = ctx.handlers[0]

  // 「请作者喝杯茶」写成伪造的模型原文，逼出打赏分支的表格化检查没必要：
  // 这里只要流不炸、块编号能接上，打赏本身由 sim/dashang 的用例去验。
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '桂枝汤：桂枝 9 克，芍药 9 克。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '桂枝汤：桂枝 9 克，芍药 9 克。' } },
    { type: 'usage', tokens: 8 },
    { type: 'finish', reason: 'stop' },
  ]
  const out = []
  for await (const c of handler({ sessionId: 's1', system: TCM_SYSTEM }, async function* () { for (const c of chunks) yield c })) out.push(c)

  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!/\d+\s*克/.test(text), '串联之后剂量必须照样遮掉：' + text)
  const opened = new Set()
  for (const c of out) {
    assert.equal(typeof c, 'object', '发出去的必须都是对象')
    if (c.type === 'block-start') opened.add(c.index)
    if (c.type === 'text-delta') assert.ok(opened.has(c.index), 'text-delta 落在没开过的块上：' + JSON.stringify(c))
  }
})

test('隔离：问诊闭麦的那一轮，资料库提醒也不许漏出来', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeCtx()
  // 问诊的闭麦登记走 ctx.effect(() => ctx.on('session/event', …))：
  // 假宿主得真执行 effect 收到的函数，事件才挂得上；inject 空转，免得开本机通道干等十秒。
  const events = []
  const baseOn = ctx.on
  ctx.on = (event, fn) => {
    if (event === 'session/event') { events.push(fn); return () => {} }
    return baseOn(event, fn)
  }
  ctx.effect = (fn) => { try { fn() } catch { /* 注册失败就跳过 */ } }
  ctx.inject = () => {}
  apply(ctx, { kbPath: '', autoIndex: false })
  assert.ok(events.length > 0, '问诊的事件监听要挂上')
  for (const fn of events) {
    fn({ id: 's-mute' }, { type: 'user/message', data: { content: '【模拟问诊 · 开局】普通｜方药｜20261122-1' } })
  }

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '旁白不该出现。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '旁白不该出现。' } },
    { type: 'finish', reason: 'stop' },
  ]
  const out = []
  for await (const c of ctx.handlers[0]({ sessionId: 's-mute', system: TCM_SYSTEM }, async function* () { for (const c of chunks) yield c })) out.push(c)
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  // 拆分时这道闸丢过：sim 写了「这轮闭麦」的标记，xuexi 收了没读，
  // 没设资料库的用户每局第一轮（恰是闭麦轮）都漏出整段提醒。
  assert.equal(text, '', '闭麦轮一个字都不许往外放，资料库提醒也算字')
})

test('隔离：出口包装器抛错时，不把异常抛给宿主', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeCtx()
  apply(ctx, { kbPath: 'D:/中医知识库' })
  const handler = ctx.handlers[0]

  // 上游第一块之后就炸：组装器要兜住，把异常吃掉、不往上抛，整轮回答不至于连不上。
  let boom = false
  const bad = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    boom = true
    throw new Error('模拟的包装器故障')
  }
  const out = []
  await assert.doesNotReject(async () => {
    for await (const c of handler({ sessionId: 's1', system: TCM_SYSTEM }, () => bad())) out.push(c)
  })
  assert.ok(boom, '故障确实发生了')
  assert.ok(out.length > 0, '故障前已经发出去的块不受影响')
  for (const c of out) assert.equal(typeof c, 'object', '发出去的必须都是对象')
  assert.ok(out.some((c) => c.type === 'block-start'), '开块的动作照旧完成')
})
