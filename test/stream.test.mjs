// 出口输出的流块必须是对象，而且 text 必须是字符串。
// 宿主累加器遇到两类毛病都会让整轮回答作废：
//   1. 收到裸字符串 → unreachable variant in AssistantStreamAccumulator.push
//   2. text-delta 的 text 不是字符串 → text-delta text must be a string
//
// 光做静态扫描挡不住第二类：代码里写的是 yield delta(chunk, piece)，看着没问题，
// 但如果 take() 已经返回对象、外面又套一层 delta，text 就变成了对象。
//
// 所以这里把源码里 llm/stream 的生成器体原样抠出来真跑一遍，喂假流块进去，
// 逐个检查发出来的东西。剂量判定用真的 dosage-guard，不造假替身——
// 替身会把要验证的分支整个绕过去，测了也白测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasDosage, blotDosage, quoteSafeCut } from '../lib/dosage-guard.js'
import { dashangBlock, hasGiftSign, missingDisclaimer } from '../lib/dashang.js'

const XUEXI = join(import.meta.dirname, '..', 'lib', 'xuexi.js')
const SIM = join(import.meta.dirname, '..', 'lib', 'sim.js')

/** 从源码里抠出一个出口包装器的函数体，做成可调用的异步生成器。 */
function grabBody(src, marker) {
  const head = src.indexOf(marker)
  assert.ok(head > 0, '找不到出口包装器：' + marker)
  const bodyStart = src.indexOf('{', head) + 1
  let depth = 1
  let i = bodyStart
  while (i < src.length && depth > 0) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    i += 1
  }
  return src.slice(bodyStart, i - 1)
}

/** 学习版那一段：剂量遮挡与开场提醒。 */
function makeStream(src, overrides = {}) {
  const body = grabBody(src, 'const stream = async function* (options, next, hint) {')

  // 真实代码里 verdict() 调的是模块作用域的 tcmVerdict，不是从 deps 拿的。
  // 默认换成「确定是中医会话」，其余一行不动，这样剂量分支才会被执行到；
  // 要验「宿主说不是中医」的分支，用 overrides.verdict 指定返回值。
  const verdictLine = overrides.verdict
    ? `const verdict = () => (${JSON.stringify(overrides.verdict)})`
    : 'const verdict = () => ({ decided: true, tcm: true })'
  const patched = body.replace(
    'const verdict = () => tcmVerdict(ctx, options?.sessionId, name)',
    verdictLine,
  )
  assert.notEqual(patched, body, '源码里找不到 verdict 定义，测试需要跟着改')

  const harness = `
    return (async function* (options, next, deps) {
      const { hasDosage, blotDosage, quoteSafeCut, dashangBlock, hasGiftSign, missingDisclaimer, ctx, name, SCAN_WINDOW } = deps
      // 会话开场提醒要查资料库路径和会话类型：默认当「已经填了路径、就是中医会话」。
      const NOTICE_BLOCK = 0
      const kbNoticed = new Set()
      // 打赏按会话只摆一次：要验重复的，从 deps 递同一个 Set 进来。
      const giftOnce = deps.giftOnce || new Set()
      const kbNotice = deps.kbNotice || (() => '')
      const currentPath = deps.currentPath || (() => 'D:/中医知识库')
      const looksTcmSession = deps.looksTcmSession || (() => true)
      const looksTcmPrompt = deps.looksTcmPrompt || (() => false)
      const versionOf = deps.versionOf || (() => '')
      // 问诊那边递过来的闭麦标记：默认没有（普通聊天），要验闭麦轮用 overrides.hint。
      const hint = deps.hint || {}
      ${patched}
    })
  `
  const factory = new Function(harness)()
  const deps = {
    hasDosage,
    blotDosage,
    quoteSafeCut,
    dashangBlock,
    hasGiftSign,
    missingDisclaimer,
    ctx: { logger: { warn() {} }, on() {} },
    name: 'dsh-tcm-xueli',
    SCAN_WINDOW: 600,
    kbNotice: overrides.kbNotice,
    currentPath: overrides.currentPath,
    looksTcmSession: overrides.looksTcmSession,
    looksTcmPrompt: overrides.looksTcmPrompt,
    versionOf: overrides.versionOf,
    hint: overrides.hint,
    giftOnce: overrides.giftOnce,
  }
  return (chunks) => {
    async function* source() {
      for (const c of chunks) yield c
    }
    return factory({ sessionId: 's1', ...(overrides.options || {}) }, source, deps)
  }
}

/** 模拟问诊那一段：闭麦与点评末尾补打赏。 */
function makeSimStream(overrides = {}) {
  const body = grabBody(readFileSync(SIM, 'utf8'), 'const stream = async function* (options, next, hint) {')
  const harness = `
    return (async function* (options, next, deps) {
      const { ctx, dashangGiftText } = deps
      const hint = deps
      const muted = { of: deps.simQuiet || (() => false) }
      const clinic = { of: deps.isPanelRound || null }
      const gifted = { due: deps.due || null }
      const clinicGiftOf = deps.clinicGiftOf || null
      ${body}
    })
  `
  const factory = new Function(harness)()
  const deps = {
    ctx: { logger: { warn() {} }, on() {} },
    dashangGiftText: overrides.dashangGiftText || (() => ''),
    simQuiet: overrides.simQuiet,
    isPanelRound: overrides.isPanelRound,
    due: overrides.due,
    clinicGiftOf: overrides.clinicGiftOf,
  }
  return (chunks) => {
    async function* source() {
      for (const c of chunks) yield c
    }
    return factory({ sessionId: 's1', ...(overrides.options || {}) }, source, deps)
  }
}

async function collect(iter) {
  const out = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

function assertAllBlocksLegal(out, where) {
  for (const c of out) {
    assert.equal(typeof c, 'object', where + '：发出去的不是对象：' + JSON.stringify(c))
    assert.ok(c !== null, where + '：发出去的是 null')
    assert.equal(typeof c.type, 'string', where + '：块没有 type：' + JSON.stringify(c))
    if (c.type === 'text-delta') {
      assert.equal(typeof c.text, 'string', where + '：text 不是字符串：' + JSON.stringify(c))
      assert.ok(Number.isSafeInteger(c.index) && c.index >= 0, where + '：index 不合法：' + JSON.stringify(c))
    }
    if (c.type === 'block-start' || c.type === 'block-end') {
      assert.ok(Number.isSafeInteger(c.index) && c.index >= 0, where + '：index 不合法：' + JSON.stringify(c))
    }
  }
}

/** 模拟宿主累加器：每个 text-delta 的 index 必须先由 block-start 开过，否则那块会丢。 */
function assertBlocksOpened(out, where) {
  const opened = new Set()
  for (const c of out) {
    if (c.type === 'block-start') opened.add(c.index)
    if (c.type === 'text-delta') {
      assert.ok(opened.has(c.index), where + '：text-delta 落在一块没开过的块上，正文会被丢掉：' + JSON.stringify(c))
    }
  }
}

const TEXT = (t) => ({ type: 'text-delta', index: 0, text: t })
const START = { type: 'block-start', index: 0 }
const END = [
  { type: 'block-end', index: 0 },
  { type: 'usage', tokens: 10 },
  { type: 'finish', reason: 'stop' },
]

test('流块类型：出口包装器里不许 yield 裸字符串字面量', () => {
  for (const file of [XUEXI, SIM]) {
    const body = grabBody(readFileSync(file, 'utf8'), 'const stream = async function* (options, next, hint) {')
    const bare = [...body.matchAll(/yield\s+('[^']*'|"[^"]*"|`[^`]*`)/g)].map((m) => m[1])
    assert.deepEqual(bare, [], file + ' 里不许 yield 裸字符串：' + bare.join(', '))
  }
})

test('流块类型：普通长回答，每块合法、正文完整', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('这是第一句。'),
    TEXT('这是第二句，还没写完'),
    TEXT('。'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '普通回答')
  assertBlocksOpened(out, '普通回答')

  const bodyText = out.filter((c) => c.type === 'text-delta' && c.index === 0).map((c) => c.text).join('')
  assert.equal(bodyText, '这是第一句。这是第二句，还没写完。', '正文一个字都不许少、不许串')
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('本节仅供学习研究'), '收尾块要补上免责声明')
  assert.ok(out.some((c) => c.type === 'finish'), 'finish 块被吞了')
})

test('流块类型：命中剂量只遮数值，药名和骨架保留', async () => {
  // 这条走的是「命中剂量 → blotDosage 遮数值 → 继续发」那条分支，
  // 早期版本正是在这条分支上把对象又包了一层，报 text-delta text must be a string。
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('这是辨证思路，正常一句。'),
    TEXT('桂枝 9g，芍药 9g。'),
    TEXT('后面还有正常的思路。'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '命中剂量')
  assertBlocksOpened(out, '命中剂量')

  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('这是辨证思路'), '正常句被误伤了：' + joined)
  assert.ok(joined.includes('后面还有正常的思路'), '正常句被误伤了：' + joined)
  assert.ok(!joined.includes('9g'), '剂量没遮干净：' + joined)
  assert.ok(joined.includes('*'), '遮掉的地方应该留个标记：' + joined)
  // 只遮数值：药名和句子骨架都得还在
  assert.ok(joined.includes('桂枝'), '药名被一起挖掉了：' + joined)
  assert.ok(joined.includes('芍药'), '药名被一起挖掉了：' + joined)
})

test('流块类型：剂量跨段时也不许把对象又包一层', async () => {
  // 这条是 2.2.2 线上真实崩过的场景，报错原文：
  //   TypeError: text-delta text must be a string
  // 成因：take() 里「整段挖掉」那条分支 yield 的是已经包好的对象，
  // 外层又对它做了一次 delta(base, piece)，text 就成了对象。
  // 触发条件：上一段带着剂量语境（进了 tail），这一段本身没有剂量。
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('桂枝12克。'),
    TEXT('这是下一句。'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '剂量跨段')
  assertBlocksOpened(out, '剂量跨段')

  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!joined.includes('12克'), '剂量没遮干净：' + joined)
  // 前一段尾巴里有语境时，这一段本身没有可遮的数，不能整段抹成 *
  assert.ok(joined.includes('这是下一句'), '后一段被整段抹掉了：' + joined)
})

test('流块类型：数字和单位被切在两块，也不许把剂量漏出去', async () => {
  // 回归用例：3.1.7 体检时发现，「桂枝 9」先到、下一块才到「克」，
  // 前半段没有单位判不出剂量就原样发了，后半段只剩一个「克」遮不到，
  // 读者最后看到的是完整剂量。
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('桂枝 9\n'),
    TEXT('克。'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '剂量切块')
  assertBlocksOpened(out, '剂量切块')

  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!joined.includes('9克'), '剂量切块后漏了出去：' + joined)
  assert.ok(joined.includes('*'), '遮掉的地方应该留个标记：' + joined)
});

test('流块类型：列表里的整张方没加引号，逐块照遮', async () => {
  // 列表逐行到达：单个换行不切段，等空行到了才整段判，整方一行一味也照样遮。
  const formula = '1. **桂枝** 9g\n2. **白芍** 9g\n3. **生姜** 9g\n4. **甘草** 6g\n\n'
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('这是转述一张方子：\n\n'),
    TEXT(formula),
    TEXT('接着讲思路。'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '整方转述')
  assertBlocksOpened(out, '整方转述')

  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('**桂枝** *'), '没加引号的整方应照遮：' + joined)
  assert.ok(joined.includes('**甘草** *'), '没加引号的整方应照遮：' + joined)
  assert.ok(joined.includes('接着讲思路'), '正常句被误伤了：' + joined)
})

test('流块类型：列表每行带句号的整方，没加引号也照遮', async () => {
  // 列表一行一句、逐行到达时，单行只有一味药；必须把整块攒到空行再判，
  // 否则每行都会被单独遮掉，整方转述照样被误伤。
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('1. **桂枝** 9g，解肌发表。\n'),
    TEXT('2. **白芍** 9g，敛阴和营。\n'),
    TEXT('3. **生姜** 9g，和胃止呕。\n'),
    TEXT('4. **甘草** 6g，调和诸药。\n'),
    TEXT('\n'),
    TEXT('接着讲思路。'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '带句号的整方')
  assertBlocksOpened(out, '带句号的整方')

  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('**桂枝** *'), '没加引号的整方应照遮：' + joined)
  assert.ok(joined.includes('**甘草** *'), '没加引号的整方应照遮：' + joined)
  assert.ok(joined.includes('接着讲思路'), '正常句被误伤了：' + joined)
})

test('流块类型：正文一直没收尾，靠结束块收走也不出问题', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('这句话没有句末标点'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '收尾块')
  assertBlocksOpened(out, '收尾块')
})

test('会话开场提醒：没填资料库时先开一块提醒，正文整体挪到 1 号块', async () => {
  const notice = '⚠️ 还没设定资料库目录：这次回答不会引书讲方，只会给治法方向。'
  const run = makeStream(readFileSync(XUEXI, 'utf8'), {
    kbNotice: () => notice,
    currentPath: () => '',
  })([START, TEXT('第一句。'), ...END])
  const out = await collect(run)
  assertAllBlocksLegal(out, '开场提醒')
  assertBlocksOpened(out, '开场提醒')

  const texts = out.filter((c) => c.type === 'text-delta')
  assert.equal(texts[0].index, 0, '提醒应该占 0 号块')
  assert.equal(texts[0].text, notice)
  const body = texts.filter((c) => c.index === 1).map((c) => c.text).join('')
  assert.equal(body, '第一句。', '正文应该整体挪到 1 号块且内容不变')
  assert.equal(texts.filter((c) => c.index === 0).length, 1, '提醒只许出现一次')
})

test('会话开场提醒：填了资料库就不提醒，正文仍在 0 号块', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), {
    kbNotice: () => '',
    currentPath: () => 'D:/中医知识库',
  })([START, TEXT('第一句。'), ...END])
  const out = await collect(run)
  assertAllBlocksLegal(out, '不提醒')
  assertBlocksOpened(out, '不提醒')

  const texts = out.filter((c) => c.type === 'text-delta')
  const body = texts.filter((c) => c.index === 0)
  assert.equal(body.map((c) => c.text).join(''), '第一句。', '正文仍在 0 号块，不该挪块')
  const tail = texts.filter((c) => c.index === 1)
  assert.ok(tail.length > 0 && tail.map((c) => c.text).join('').includes('本节仅供学习研究'), '收尾块自己一块')
})

test('问诊闭麦的那一轮：就算没填资料库，提醒也不许漏出来', async () => {
  // 拆分时丢过这道闸：hint.muted 递进来了却没人读，闭麦轮照样插提醒。
  const run = makeStream(readFileSync(XUEXI, 'utf8'), {
    kbNotice: () => '⚠️ 还没设定资料库目录',
    currentPath: () => '',
    hint: { muted: true },
  })([START, TEXT('第一句。'), ...END])
  const out = await collect(run)
  assertAllBlocksLegal(out, '闭麦轮不提醒')
  assertBlocksOpened(out, '闭麦轮不提醒')
  assert.ok(!JSON.stringify(out).includes('⚠️'), '闭麦轮一个字都不许往外放，提醒也不行')
  const texts = out.filter((c) => c.type === 'text-delta')
  assert.ok(texts.every((c) => c.index === 0), '不提醒就不挪块')
})

test('不是中医会话：原样转发，一个字节都不动', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), {
    looksTcmSession: () => false,
    kbNotice: () => '⚠️ 不该出现的提醒',
  })([START, TEXT('桂枝三两。'), ...END])
  const out = await collect(run)
  assertAllBlocksLegal(out, '非中医会话')
  assert.equal(out.length, 5, '非中医会话应该原样转发：' + JSON.stringify(out))
  assert.equal(out[1].text, '桂枝三两。', '非中医会话不许挖句')
  assert.ok(!JSON.stringify(out).includes('⚠️'), '非中医会话不许插提醒')
})
test('点评别人的方：带现代克数的引文也验真照遮，不含克数的原文才放过', async () => {
  // 新口径（引文验真）：经典原文用两、钱、枚，不用现代克数。引号里一旦出现「数字＋克/g」，
  // 就认定不是古籍原文（多是转述的原单或自拟方），豁免取消、照遮；模型自己新加的量永远照遮。
  const messages = [
    { role: 'system', content: '你是中医助手。' },
    { role: 'user', content: '这是我拿到的方：黄芪30g、当归15g、白术10g，请点评。' },
    { role: 'assistant', content: '好的，我先看方。' },
  ]
  const run = (chunks) =>
    makeStream(readFileSync(XUEXI, 'utf8'), { options: { messages } })(chunks)
  const joinedOf = (out) => out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

  const quoted = await collect(
    run([
      START,
      TEXT('原单上「黄芪 30g、当归 15g、白术 10g」三味，都是补气健脾的路子。'),
      TEXT('可以再加陈皮 6g，理气。'),
      ...END,
    ]),
  )
  assertAllBlocksLegal(quoted, '点评原单')
  assertBlocksOpened(quoted, '点评原单')
  const q = joinedOf(quoted)
  assert.ok(q.includes('黄芪 *'), '引号里带现代克数的原单也要验真照遮：' + q)
  assert.ok(q.includes('当归 *'), '引号里带现代克数的原单也要验真照遮：' + q)
  assert.ok(q.includes('白术 *'), '引号里带现代克数的原单也要验真照遮：' + q)
  assert.ok(q.includes('陈皮 *'), '模型自己新给的量没遮：' + q)
  assert.ok(!q.includes('30g') && !q.includes('15g') && !q.includes('10g') && !q.includes('6g'), '带克数的引文与自拟量都要遮干净：' + q)

  const bare = await collect(
    run([START, TEXT('原单上黄芪 30g、当归 15g，剂量偏小。'), ...END]),
  )
  const b = joinedOf(bare)
  assert.ok(!b.includes('30g') && !b.includes('15g'), '没加引号的转述漏遮：' + b)
  assert.ok(b.includes('黄芪 *') && b.includes('当归 *'), '没加引号的转述应照遮：' + b)
})

test('会话认不出来但提示词带学理模式总纲：仍按中医会话遮数', async () => {
  const system = '【学理模式·总纲——本节优先于下文任何出方规则】……其余口径……'
  const run = makeStream(readFileSync(XUEXI, 'utf8'), {
    looksTcmSession: () => false,
    looksTcmPrompt: (text) => typeof text === 'string' && text.includes('【学理模式·总纲'),
    options: { system },
  })([START, TEXT('生姜 25g，先煎十分钟。'), ...END])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('生姜 *'), '提示词是学理模式却没遮：' + joined)
})

test('宿主说不是中医会话，但这次提示词带学理模式总纲：仍按中医会话遮数', async () => {
  // 宿主没拿到会话对象、或者预设投影落空时，会给出「确定不是中医」的结论；
  // 只要这次请求的 system 里确实带着学理模式总纲，口径就还得在。
  const system = '【学理模式·总纲——本节优先于下文任何出方规则】……其余口径……'
  const run = makeStream(readFileSync(XUEXI, 'utf8'), {
    verdict: { decided: true, tcm: false },
    looksTcmPrompt: (text) => typeof text === 'string' && text.includes('【学理模式·总纲'),
    options: { system },
  })([START, TEXT('生姜 25g，先煎十分钟。'), ...END])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('生姜 *'), '提示词是学理模式却没遮：' + joined)
})

test('会话认不出来、提示词也不是学理模式：一个字节都不动', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), {
    looksTcmSession: () => false,
    looksTcmPrompt: () => false,
    options: { system: '你是通用助手。' },
  })([START, TEXT('生姜 25g，先煎十分钟。'), ...END])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined, '生姜 25g，先煎十分钟。')
})

test('流块类型：不含现代克数的引文被句号、换行切开，跨块也不许误遮', async () => {
  // 引一整句原文（经典用「两」，不含现代克数，验真后仍豁免）时，句号往往先到；
  // 旧逻辑立刻在句号处切段，这一块只剩半个引文，被判成「没加引号」而误遮。
  // 切点现在会前移到开引号处等闭合，整段引文照原样放过。
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('（原文：「桂枝三两，芍药六两。'),
    TEXT('共七剂。」）\n'),
    TEXT('原文：「甘草六两\n'),
    TEXT('生姜九两」\n'),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '引文跨块')
  assertBlocksOpened(out, '引文跨块')
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(joined.includes('桂枝三两'), '不含克数的引文被误遮：' + joined)
  assert.ok(joined.includes('甘草六两'), '不含克数的引文被误遮：' + joined)
  assert.ok(!joined.includes('桂枝*'), '不含克数的引文被误遮：' + joined)
})

test('收块全文（block-end）也要遮：宿主拿它当权威整体替换，不遮等于没遮', async () => {
  // S1 回归：宿主按 block-end 里的全文整体替换显示、落盘、回放（First close wins）。
  // 只遮 text-delta 增量没用——收束后全文一回显，克数又出来了。收块前必须把全文也遮一遍。
  const full = '桂枝9克，白芍6克。'
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('桂枝9克，'),
    TEXT('白芍6克。'),
    { type: 'block-end', index: 0, block: { type: 'text', text: full } },
    { type: 'usage', tokens: 10 },
    { type: 'finish', reason: 'stop' },
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '收块全文')
  const end = out.find((c) => c.type === 'block-end' && c.index === 0 && c.block)
  assert.ok(end, '要有带全文的收块')
  assert.equal(end.block.text, '桂枝*，白芍*。', '收块全文没遮：' + end.block.text)
  const joined = out.filter((c) => c.type === 'text-delta' && c.index === 0).map((c) => c.text).join('')
  assert.ok(!joined.includes('9克') && !joined.includes('6克'), '增量也要遮：' + joined)
})

test('推理通道（reasoning）也遮：思考过程里的克数同样不许漏', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: '思考：桂枝9克先煎。' },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: '思考：桂枝9克先煎。' } },
    TEXT('正常正文一句。'),
    { type: 'block-end', index: 0, block: { type: 'text', text: '正常正文一句。' } },
    { type: 'usage', tokens: 10 },
    { type: 'finish', reason: 'stop' },
  ])
  const out = await collect(run)
  const rd = out.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.ok(!rd.includes('9克'), '推理增量没遮：' + rd)
  assert.ok(rd.includes('桂枝*'), '推理增量应留标记：' + rd)
  const re = out.find((c) => c.type === 'block-end' && c.block && c.block.type === 'reasoning')
  assert.ok(re && !re.block.text.includes('9克'), '推理收块全文没遮：' + JSON.stringify(re))
})

test('全角数字跨块也不漏：「桂枝９」＋「克」两块拼起来照遮', async () => {
  // 句尾悬空数字压住等下一块单位：半角全角都要认，否则「９」先发、「克」后到就漏遮。
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('桂枝９\n'),
    TEXT('克，水煎服。'),
    ...END,
  ])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.ok(!joined.includes('９克') && !joined.includes('9克'), '全角剂量切块后漏了：' + joined)
  assert.ok(joined.includes('*'), '应留遮罩标记：' + joined)
})

test('高频漏网补上：9克口服、9克分服、9克日二次都遮', async () => {
  for (const s of ['桂枝9克口服。', '桂枝9克分服。', '桂枝9克日二次。']) {
    const run = makeStream(readFileSync(XUEXI, 'utf8'))([START, TEXT(s), ...END])
    const out = await collect(run)
    const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.ok(!joined.includes('9克'), '没遮：' + joined)
    assert.ok(joined.includes('*'), '应留标记：' + joined)
  }
})

test('被系统通知叫醒的一轮：文字清空，工具块照旧转发', async () => {
  const run = makeSimStream({ simQuiet: () => true })([
    START,
    TEXT('我是旁白，不该出现。'),
    { type: 'tool-call', index: 1, name: 'send_message', input: { text: '你好' } },
    { type: 'block-end', index: 0, block: { type: 'text', text: '我是旁白，不该出现。' } },
    { type: 'usage', tokens: 5 },
    { type: 'finish', reason: 'stop' },
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '闭嘴的一轮')
  const texts = out.filter((c) => c.type === 'text-delta').map((c) => c.text)
  assert.deepEqual(texts, [], '闭嘴的一轮不许往外发正文')
  for (const c of out) {
    if (c.block && typeof c.block.text === 'string') assert.equal(c.block.text, '', '正文块末的全文也要清空')
  }
  const call = out.find((c) => c.type === 'tool-call')
  assert.ok(call, '工具块不许丢：丢了宿主会报 unknown tool')
  assert.equal(call.name, 'send_message')
})

/* ── 打赏区：学习版这条线（回答末尾真出了那两句声明才补，一局只摆一次） ── */

const SIGN_LEARN = '【中医 · 经方（学习版）】本节仅供学习研究，不构成诊疗建议；如需用药或施针请由执业中医师面诊。'
const SIGN_HALLU = '⚠️ AI 有幻觉：以上内容由人工智能生成，可能编造原文、记错条文或张冠李戴，请自行核对原书后再用。'

test('打赏区：回答末尾带那句声明，就补一块', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('**结论**：太阳表虚，营卫不和。'),
    TEXT('桂枝汤证，按方调。'),
    TEXT(SIGN_LEARN),
    TEXT(SIGN_HALLU),
    ...END,
  ])
  const out = await collect(run)
  assertAllBlocksLegal(out, '学习版打赏')
  assertBlocksOpened(out, '学习版打赏')
  const gift = out.filter((c) => c.type === 'text-delta' && c.text.includes('dashang-qr.png'))
  assert.equal(gift.length, 1, '出了声明就补，而且只补一块')
  assert.ok(gift[0].text.includes('请作者喝杯茶'), '标题照旧')
  assert.ok(gift[0].text.includes('打赏全凭自愿'), '自愿说明照旧')
  const finish = out.find((c) => c.type === 'finish')
  assert.equal(out[out.indexOf(finish) - 1].type, 'block-end', '打赏块要在结尾之前收好')
})

test('打赏区：只有一句声明也补', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), { options: { system: '学理模式', sessionId: 'session-half-sign' } })([
    START,
    TEXT('## 一、结论'),
    TEXT('桂枝汤证与麻黄汤证的分水岭在有汗无汗。'),
    TEXT('只有一句声明也得出打赏：'),
    TEXT(SIGN_LEARN),
    ...END,
  ])
  const out = await collect(run)
  const gift = out.filter((c) => c.type === 'text-delta' && c.text.includes('dashang-qr.png'))
  assert.equal(gift.length, 1, '两句里出任意一句都要补')
})

test('免责声明：模型漏写就由代码补上，补完照摆打赏', async () => {
  // 声明是硬性的，不许因为它缺席就不补；补上之后就算「给了说法」，打赏一块照摆。
  for (const first of ['## 一、结论', '## 手上的线索', '病人问：我这头疼几天了，要紧吗？']) {
    const run = makeStream(readFileSync(XUEXI, 'utf8'), { options: { system: '学理模式', sessionId: 'session-lack-' + first.length } })([
      START,
      TEXT(first),
      TEXT('。'),
      ...END,
    ])
    const out = await collect(run)
    const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.ok(joined.includes('本节仅供学习研究'), '第一行声明要补上：' + first.slice(0, 6))
    assert.ok(joined.includes('AI 有幻觉'), '第二行声明也要补上：' + first.slice(0, 6))
    const gift = out.filter((c) => c.type === 'text-delta' && c.text.includes('dashang-qr.png'))
    assert.equal(gift.length, 1, '声明补上之后打赏照摆一块：' + first.slice(0, 6))
  }
})

test('免责声明：模型已经写了的，不再重复贴一遍', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), { options: { system: '学理模式', sessionId: 'session-no-dup' } })([
    START,
    TEXT('**结论**：太阳表虚。'),
    TEXT(SIGN_LEARN),
    TEXT(SIGN_HALLU),
    ...END,
  ])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined.split('本节仅供学习研究').length - 1, 1, '第一行只许出现一次')
  assert.equal(joined.split('AI 有幻觉').length - 1, 1, '第二行只许出现一次')
})

test('免责声明：补上去的两行排在打赏前面', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), { options: { system: '学理模式', sessionId: 'session-order' } })([
    START,
    TEXT('**结论**：太阳表虚。'),
    ...END,
  ])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const atSign = joined.indexOf('本节仅供学习研究')
  const atHallu = joined.indexOf('AI 有幻觉')
  const atGift = joined.indexOf('dashang-qr.png')
  assert.ok(atSign > 0 && atHallu > atSign, '两行声明要按原顺序补')
  assert.ok(atGift > atHallu, '打赏要排在声明之后')
})

test('免责声明：只调工具、没写正文的那一轮不补', async () => {
  // 一轮里先调 grep 再写答案的情况很常见；提前补声明就会一局贴好几遍。
  const run = makeStream(readFileSync(XUEXI, 'utf8'), { options: { system: '学理模式', sessionId: 'session-tool-only' } })([
    START,
    { type: 'tool-call', index: 1, name: 'grep', input: { pattern: '柴胡' } },
    { type: 'finish', reason: 'tool-calls' },
  ])
  const out = await collect(run)
  const texts = out.filter((c) => c.type === 'tool-call')
  assert.equal(texts.length, 1, '工具块照旧转发')
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined, '', '没写正文就不许贴声明：' + joined)
})

test('免责声明：写了字又调工具的那一轮也不收尾，等真正写完那轮', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), { options: { system: '学理模式', sessionId: 'session-tool-after-text' } })([
    START,
    TEXT('我先查一下原文。'),
    { type: 'tool-call', index: 1, name: 'grep', input: { pattern: '柴胡' } },
    { type: 'finish', reason: 'tool-calls' },
  ])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined, '我先查一下原文。', '话没说完就不收尾：' + joined)
})

test('免责声明：闭麦那一轮一个字都不许往外放', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), { hint: { muted: true } })([
    START,
    TEXT('**结论**：太阳表虚。'),
    ...END,
  ])
  const out = await collect(run)
  const joined = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(joined, '**结论**：太阳表虚。', '闭麦轮不许补声明、不许摆打赏')
})

test('打赏区：回答里已经有打赏码的，不再补第二块', async () => {
  const abs = 'D:/x/assets/dashang/dashang-qr.png'
  const inner = '--- **这一节要是帮到你，可以请作者喝杯茶：** ![打赏码](' + abs + ') 打赏全凭自愿。'
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    { type: 'text-delta', index: 0, text: '正文。' },
    { type: 'text-delta', index: 0, text: inner },
    { type: 'text-delta', index: 0, text: SIGN_LEARN },
    ...END,
  ])
  const out = await collect(run)
  const gift = out.filter((c) => c.type === 'text-delta' && c.text.includes('dashang-qr.png'))
  assert.equal(gift.length, 1, '同一份回答只许一块打赏区')
})

test('打赏区：同一个会话只摆一次，第二回再出声明也不摆', async () => {
  const shared = new Set()
  const opts = { options: { system: '学理模式', sessionId: 'session-gift-once' } }
  const first = await collect(makeStream(readFileSync(XUEXI, 'utf8'), { ...opts, giftOnce: shared })([
    START,
    TEXT('**结论**：太阳表虚，营卫不和。'),
    TEXT(SIGN_LEARN),
    ...END,
  ]))
  assert.equal(first.filter((c) => c.type === 'text-delta' && c.text.includes('dashang-qr.png')).length, 1, '第一回要摆')
  const second = await collect(makeStream(readFileSync(XUEXI, 'utf8'), { ...opts, giftOnce: shared })([
    START,
    TEXT('**结论**：再说一遍，还是表虚。'),
    TEXT(SIGN_LEARN),
    ...END,
  ]))
  assert.equal(second.filter((c) => c.type === 'text-delta' && c.text.includes('dashang-qr.png')).length, 0, '同一会话第二回不再摆')
})

test('打赏区：摆在两行声明之后，不在声明前面', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'))([
    START,
    TEXT('**结论**：太阳表虚，营卫不和。'),
    TEXT('## 手上的线索'),
    TEXT('够定的是：主症、病程。'),
    TEXT(SIGN_LEARN),
    TEXT(SIGN_HALLU),
    ...END,
  ])
  const out = await collect(run)
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const atSign = text.indexOf(SIGN_LEARN)
  const atHallu = text.indexOf(SIGN_HALLU)
  const atGift = text.indexOf('dashang-qr.png')
  assert.ok(atSign > 0 && atHallu > atSign, '声明两行要照旧写在回答里')
  assert.ok(atGift > atHallu, '打赏区要排在声明之后')
  assert.ok(text.indexOf('打赏全凭自愿') > atGift, '自愿说明在码后面')
})

test('打赏区：模拟问诊面板开的局，学习版这层不再补第二块', async () => {
  const run = makeStream(readFileSync(XUEXI, 'utf8'), { hint: { clinic: true } })([
    START,
    TEXT('**结论**：太阳表虚。'),
    TEXT(SIGN_LEARN),
    ...END,
  ])
  const out = await collect(run)
  const gift = out.filter((c) => c.type === 'text-delta' && c.text.includes('dashang-qr.png'))
  assert.equal(gift.length, 0, '面板局打赏归模拟问诊按十局算，这层不许补')
})
