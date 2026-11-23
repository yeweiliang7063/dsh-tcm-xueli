import test from 'node:test'
import assert from 'node:assert/strict'

import { createStore, TOOL_NAMES } from '../lib/clinic.js'

test('问诊记录：开局记题面、交卷记成绩、列表按时间倒序', async () => {
  const store = createStore()
  const first = await store.begin({
    id: '20261119-1',
    level: '普通',
    direction: '方药',
    caseSummary: '男 45 岁，胃脘痞满',
    patientId: 'patient-aaa',
    doctorId: 'doctor-bbb',
  })
  assert.equal(first.id, '20261119-1')
  assert.equal(first.level, '普通')
  assert.equal(first.patientId, 'patient-aaa')

  const second = await store.begin({ id: '20261119-2', level: '困难', direction: '针药' })
  assert.equal(second.id, '20261119-2')

  const ended = await store.end({
    id: '20261119-1',
    verdict: '边缘',
    failLine: '主方选对了，漏问小便',
    failPoints: ['没问起夜'],
    mustAsk: ['小便颜色', '起夜几次'],
    prescribe: '半夏泻心汤',
  })
  assert.equal(ended.verdict, '边缘')
  assert.deepEqual(ended.mustAsk, ['小便颜色', '起夜几次'])

  const rows = await store.list(10)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, '20261119-2', '新的在前')
  const firstRow = rows.find((row) => row.id === '20261119-1')
  assert.equal(firstRow.verdict, '边缘')
  assert.ok(firstRow.finishedAt > 0)
})

test('问诊记录只在内存：新建一个记录库读不到上一份的东西', async () => {
  const one = createStore()
  await one.begin({ id: 'A-1', level: '简单', direction: '针灸' })
  await one.end({ id: 'A-1', verdict: '过关' })
  assert.equal((await one.list(5)).length, 1)

  const another = createStore()
  assert.equal((await another.list(5)).length, 0, '不落盘，换一份就是空的')
})

test('问诊记录不碰磁盘：模块里没有写文件的导入', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const code = await readFile(join(here, '..', 'lib', 'clinic.js'), 'utf8')
  assert.equal(code.includes('writeFile'), false, '不该再写 rounds.json')
  assert.equal(code.includes('mkdir'), false, '不该再建记录目录')
  assert.equal(code.includes('rounds.json'), false, '不该再提记录文件')
})

test('问诊工具名带 xueli_ 前缀，不会和岐黄工作台的同名工具撞车', () => {
  assert.deepEqual(TOOL_NAMES, ['xueli_draw_anchor', 'xueli_begin_round', 'xueli_finish_round', 'xueli_list_rounds'])
})

test('问诊工具真的注册得进：三个名字都交到宿主工具服务手上', async () => {
  const { registerClinicTools } = await import('../lib/clinic.js')
  const seen = []
  const fakeTools = {
    register(definition) {
      seen.push(definition)
      return () => {}
    },
  }
  const ctx = {
    get: (name) => (name === 'tools' ? fakeTools : undefined),
    logger: { warn() {} },
  }
  const release = await registerClinicTools(ctx, createStore())
  assert.deepEqual(seen.map((d) => d.name), TOOL_NAMES)
  for (const definition of seen) {
    assert.equal(typeof definition.execute, 'function', definition.name + ' 要有 execute')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.parameters.additionalProperties, 'boolean',
      definition.name + ' 的参数要显式声明 additionalProperties')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
  assert.equal(typeof release, 'function')
  release()
})

test('同一局号重开：上一局的结论不会带过来', async () => {
  const store = createStore()
  await store.begin({ id: 'R-1', level: '普通', direction: '方药' })
  await store.end({ id: 'R-1', verdict: '不过关', failLine: '选错方' })
  const again = await store.begin({ id: 'R-1', level: '困难', direction: '针药' })
  assert.equal(again.verdict, undefined)
  assert.equal(again.failLine, undefined)
  assert.equal(again.level, '困难')
})

test('工具参数：难度、方向、结论只能填规定的那几个，不许自由发挥', async () => {
  const { registerClinicTools, TOOL_NAMES } = await import('../lib/clinic.js')
  const seen = {}
  const tools = { register: (definition) => { seen[definition.name] = definition; return () => {} } }
  const ctx = { get: (key) => (key === 'tools' ? tools : undefined), logger: { info() {}, warn() {} } }
  const release = await registerClinicTools(ctx, { begin: async () => ({}), end: async () => ({}), list: async () => [] })
  assert.deepEqual(Object.keys(seen).sort(), TOOL_NAMES.slice().sort())
  const begin = seen.xueli_begin_round.parameters.properties
  assert.deepEqual(begin.level.enum, ['简单', '普通', '困难'])
  assert.deepEqual(begin.direction.enum, ['方药', '针灸', '针药'])
  assert.deepEqual(seen.xueli_finish_round.parameters.properties.verdict.enum, ['过关', '边缘', '不过关'])
  release()
})

test('两版工具不许串：全量版会话里这三件工具不挂上去', async () => {
  const { registerClinicTools } = await import('../lib/clinic.js')
  const opts = []
  const tools = {
    register(definition, options) {
      opts.push({ name: definition.name, options })
      return () => {}
    },
  }
  const registry = (presetId) => ({ presetForSession: () => presetId })
  const make = (presetId) => ({
    get: (key) => (key === 'tools' ? tools : key === 'agentPresets' ? registry(presetId) : undefined),
    logger: { info() {}, warn() {} },
  })
  await registerClinicTools(make('dsh-qihuangjingfang'), { begin: async () => ({}), end: async () => ({}), list: async () => [] })
  const firstFour = opts.slice(-4)
  assert.equal(firstFour.length, 4, '四个工具都要注册')
  for (const one of firstFour) {
    assert.equal(typeof one.options?.when, 'function', one.name + ' 注册时要带上启停条件')
    assert.equal(one.options.when({ agent: { session: {} } }), false, one.name + ' 在全量版会话里不该出现')
  }
  const full = opts.at(-1).options.when
  assert.equal(typeof full, 'function', '注册时要带上启停条件')
  assert.equal(full({ agent: { session: {} } }), false, '全量版会话里不该出现学习版工具')

  await registerClinicTools(make('dsh-tcm-xueli'), { begin: async () => ({}), end: async () => ({}), list: async () => [] })
  const xueli = opts.at(-1).options.when
  assert.equal(xueli({ agent: { session: {} } }), true, '学习版会话里要照常出现')

  await registerClinicTools(
    { get: (key) => (key === 'tools' ? tools : undefined), logger: { info() {}, warn() {} } },
    { begin: async () => ({}), end: async () => ({}), list: async () => [] },
  )
  const unknown = opts.at(-1).options.when
  assert.equal(unknown({ agent: { session: {} } }), true, '认不出是哪一版时按原样挂，不乱拦')
})

test('锚点：难度定池、两病机不重复、八局窗口不抽重', async () => {
  const store = createStore()
  const hard = ['寒热错杂', '虚实夹杂', '津液受伤', '血瘀', '上热下寒', '真寒假热']
  const normal = ['表里同病', '气机不畅', '水饮内停', '湿热内蕴', '痰湿中阻', '食积']
  const easy = ['寒证', '热证', '虚证', '实证']
  for (let i = 0; i < 30; i += 1) {
    const drawn = store.drawAnchor('困难')
    const parts = drawn.anchor.split('|')
    assert.equal(parts.length, 4)
    assert.notEqual(parts[1], parts[2], '两个病机不许相同')
    assert.ok(hard.includes(parts[1]) && hard.includes(parts[2]), '困难档只从困难池抽')
    assert.ok(drawn.line.includes('起手经络：') && drawn.line.includes('诱因：'))
  }
  const eight = []
  for (let i = 0; i < 8; i += 1) {
    const drawn = store.drawAnchor('普通')
    eight.push(drawn.anchor)
    const parts = drawn.anchor.split('|')
    assert.ok(normal.includes(parts[1]) && normal.includes(parts[2]), '普通档只从普通池抽')
  }
  assert.equal(new Set(eight).size, 8, '八局窗口内不该抽到重复锚点')
  const e = store.drawAnchor('简单').anchor.split('|')
  assert.ok(easy.includes(e[1]) && easy.includes(e[2]), '简单档只从简单池抽')
  // 非法难度不再静默回落普通池：store 层明确报错（工具层 enum 已挡，这里不许吞）
  assert.throws(() => store.drawAnchor('地狱'), /难度/)
  assert.throws(() => store.drawAnchor(''), /难度/)
})

test('抽过的锚点存进盘里：重启后同一锚点不会再抽到', () => {
  const saved = []
  const first = createStore({ loadSeen: () => [], saveSeen: (list) => saved.push(...list) })
  const one = first.drawAnchor('普通')
  assert.equal(saved.at(-1), one.anchor)

  // 模拟重启：内存空了，但上次存的那条读回来。
  // 只保证「八局窗口内」不重复——再往后（第 9 局起）允许重新抽到同一锚点，
  // 所以这里只查满一窗：多抽几局就撞上属正常，抽到就跳红是测错了。
  const second = createStore({ loadSeen: () => [one.anchor] })
  for (let i = 0; i < 8; i += 1) {
    assert.notEqual(second.drawAnchor('普通').anchor, one.anchor, '八局内不许抽到同一个锚点')
  }
})

test('最近几局也落一份：重启后 list_rounds 照样翻得到题面', async () => {
  const disk = []
  const first = createStore({ loadRounds: () => disk, saveRound: (row) => disk.push({ ...row }) })
  await first.begin({ id: '20260101-7', level: '简单', direction: '方药', caseSummary: '女 35 岁 头痛' })
  await first.end({ id: '20260101-7', verdict: '过关', prescribe: '小柴胡汤' })
  assert.equal(disk.length, 2, '开局记一条、判完覆盖一条')

  const second = createStore({ loadRounds: () => disk })
  const rows = await second.list(5)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].caseSummary, '女 35 岁 头痛')
  assert.equal(rows[0].verdict, '过关')
})

test('打赏每判完十局一次：按医生会话号标记（局号≠会话号），同一局重判拒绝覆盖', async () => {
  let saved = { total: 0, giftAt: 0 }
  const mk = () => createStore({
    loadProgress: () => ({ ...saved }),
    saveProgress: (p) => { saved = { ...p }; return true },
  })
  const store = mk()
  const doctor = 'session-doctor-001'
  for (let i = 1; i <= 9; i += 1) {
    await store.begin({ id: 'r-' + i, level: '普通', direction: '方药', doctorId: doctor })
    await store.end({ id: 'r-' + i, verdict: '过关', doctorId: doctor })
    assert.equal(store.hasGift(doctor), false, '第 ' + i + ' 局还没满十')
    assert.equal(store.takeGift(doctor), null, '第 ' + i + ' 局不摆打赏')
  }
  await store.begin({ id: 'r-10', level: '普通', direction: '方药', doctorId: doctor })
  await store.end({ id: 'r-10', verdict: '过关', doctorId: doctor })
  assert.equal(saved.total, 10, '判完十局')
  assert.equal(store.hasGift(doctor), true, '满十局：按会话号标记待摆')
  assert.equal(store.hasGift('r-10'), false, '局号不是会话号，问局号问不到')
  assert.equal(store.takeGift('r-10'), null, '拿局号来领一律没有')
  // 同一局再判一次：拒绝覆盖，不重复数，也不再补一次打赏
  const again = await store.end({ id: 'r-10', verdict: '不过关', doctorId: doctor })
  assert.equal(again.alreadyFinished, true, '已判的局拒绝覆盖')
  assert.equal(again.verdict, '过关', '原结论不动')
  assert.equal(saved.total, 10, '同一局重判不重复数')
  assert.deepEqual(store.takeGift(doctor), { rounds: 10 }, '满十局那一会话摆一次')
  assert.equal(store.takeGift(doctor), null, '同一档只摆一次')
  assert.equal(store.hasGift(doctor), false, '领完就没有了')

  // 模拟重启：从盘上读回来接着数；同一个医生会话判到第二十局，再摆一次
  const restart = mk()
  for (let i = 11; i <= 20; i += 1) {
    await restart.begin({ id: 'r-' + i, level: '简单', direction: '针药', doctorId: doctor })
    await restart.end({ id: 'r-' + i, verdict: '边缘', doctorId: doctor })
  }
  assert.equal(saved.total, 20)
  assert.deepEqual(restart.takeGift(doctor), { rounds: 20 }, '第二十局再摆一次（同一会话的下一档照常）')
  assert.equal(restart.takeGift(doctor), null)
})

/* ── 回合状态机：锚点按会话、end 校验、doctorId 落盘 ── */

test('锚点按会话隔离：两个医生会话各用各的底牌，取走即清', async () => {
  const store = createStore()
  const a = store.drawAnchor('普通', 'doc-A')
  const b = store.drawAnchor('困难', 'doc-B')
  const rowA = await store.begin({ id: 'r-A', level: '普通', direction: '方药', doctorId: 'doc-A' })
  const rowB = await store.begin({ id: 'r-B', level: '困难', direction: '针药', doctorId: 'doc-B' })
  assert.equal(rowA.anchor, a.anchor, 'A 会话只用 A 抽的底牌')
  assert.equal(rowB.anchor, b.anchor, 'B 会话只用 B 抽的底牌')
  // 取走即清：没再抽就开下一局，不沿用上一局的底牌
  const rowA2 = await store.begin({ id: 'r-A2', level: '普通', direction: '方药', doctorId: 'doc-A' })
  assert.equal(rowA2.anchor, '', '底牌一局一抽，不跨局沿用')
  // 没抽过锚的会话：不硬拒（协议允许工具调不动时自抽代用），只是没有抽题记录
  const rowC = await store.begin({ id: 'r-C', level: '普通', direction: '方药', doctorId: 'doc-C' })
  assert.ok(rowC, '没抽锚也能开局（协议兼容）')
  assert.equal(rowC.anchor, '')
})

test('end 校验：没开过的局不能判；doctorId 落进记录', async () => {
  const disk = []
  const store = createStore({ loadRounds: () => disk, saveRound: (row) => { disk.push({ ...row }); return true } })
  assert.equal(await store.end({ id: '不存在', verdict: '过关' }), null, '无 begin 的局拒绝判')
  await store.begin({ id: 'r-1', level: '普通', direction: '方药', doctorId: 'doc-begin' })
  const ended = await store.end({ id: 'r-1', verdict: '过关', doctorId: 'doc-end' })
  assert.equal(ended.doctorId, 'doc-end', 'end 传入的 doctorId 要落盘')
  assert.equal(disk.at(-1).doctorId, 'doc-end', '磁盘那份也有 doctorId')
  // begin 传了 doctorId、end 没传：沿用 begin 的
  await store.begin({ id: 'r-2', level: '普通', direction: '方药', doctorId: 'doc-keep' })
  const kept = await store.end({ id: 'r-2', verdict: '边缘' })
  assert.equal(kept.doctorId, 'doc-keep')
})

test('落盘失败不静默：记日志，begin/end 如实回报 persisted=false', async () => {
  const warns = []
  const logger = { warn: (...args) => warns.push(args) }
  const store = createStore({ logger, saveRound: () => false, saveProgress: () => false })
  const row = await store.begin({ id: 'r-1', level: '普通', direction: '方药', doctorId: 'd' })
  assert.equal(row.persisted, false, '落盘失败要如实回报')
  assert.ok(warns.length >= 1, '落盘失败要记日志')
  const before = warns.length
  const ended = await store.end({ id: 'r-1', verdict: '过关', doctorId: 'd' })
  assert.equal(ended.persisted, false)
  assert.ok(warns.length > before, '判完落盘失败也要记日志（含打赏计数）')

  const thrown = createStore({ logger, saveRound: () => { throw new Error('盘满了') } })
  const row2 = await thrown.begin({ id: 'r-2', level: '普通', direction: '方药' })
  assert.equal(row2.persisted, false, '抛异常也算失败，不拖垮开局')
})

/* ── 工具层：底牌不进界面、判卷字段遮罩、失败文案如实 ── */

async function registeredTools(store) {
  const { registerClinicTools } = await import('../lib/clinic.js')
  const seen = {}
  const tools = { register: (definition) => { seen[definition.name] = definition; return () => {} } }
  const ctx = { get: (key) => (key === 'tools' ? tools : undefined), logger: { info() {}, warn() {} } }
  const release = await registerClinicTools(ctx, store)
  return { seen, release }
}

const renderText = (definition, value) => definition.output.render({}, value).map((b) => b.text).join('')

test('抽题工具：人类可见的渲染不含底牌，给模型的 message 保留锚点', async () => {
  const store = createStore()
  const { seen, release } = await registeredTools(store)
  const draw = seen.xueli_draw_anchor
  const value = await draw.execute({ level: '普通' }, { agent: { id: 'doc-X' } })
  assert.equal(value.ok, true)
  assert.ok(value.message.includes('【本局锚点】'), '模型那份要有锚点（主持人判卷需要）')
  const shown = renderText(draw, value)
  assert.ok(!shown.includes('【本局锚点】'), '界面不许出现底牌标记')
  assert.ok(!shown.includes(value.anchor), '界面不许出现锚点明文')
  assert.ok(!shown.includes(value.anchor.split('|')[0]), '连六经都不许露')
  assert.ok(shown.includes('已抽题'), '中性文案')
  // 非法难度：工具层如实报错，不静默回落
  const bad = await draw.execute({ level: '地狱' }, { agent: { id: 'doc-X' } })
  assert.equal(bad.ok, false)
  assert.ok(bad.message.includes('难度'))
  release()
})

test('交卷工具：failPoints/mustAsk 每条过剂量遮罩；无开局/已判拒绝；落盘失败文案如实', async () => {
  const warns = []
  const store = createStore({ logger: { warn: (...args) => warns.push(args) }, saveRound: () => false })
  const { seen, release } = await registeredTools(store)
  const finish = seen.xueli_finish_round
  const begin = seen.xueli_begin_round

  // 没开局就判：拒绝
  const missing = await finish.execute({ id: 'r-无', verdict: '过关' }, { agent: { id: 'doc' } })
  assert.equal(missing.ok, false)
  assert.ok(missing.message.includes('没有开局记录'))

  const begun = await begin.execute({ id: 'r-1', level: '普通', direction: '方药', case_summary: '男 45 岁' }, { agent: { id: 'doc' } })
  assert.ok(begun.message.includes('落盘失败'), '开局落盘失败要如实说')

  const value = await finish.execute({
    id: 'r-1',
    verdict: '不过关',
    fail_line: '桂枝用了 30g 超量',
    fail_points: ['附子 15g 未先煎', '麻黄 9g 过汗'],
    must_ask: ['是否汗出', '小便颜色'],
    prescribe: '桂枝汤 桂枝 9g',
  }, { agent: { id: 'doc' } })
  assert.equal(value.ok, true)
  assert.ok(value.message.includes('落盘失败'), '判完落盘失败要如实说')
  const row = store.snapshot().find((r) => r.id === 'r-1')
  for (const one of [...row.failPoints, ...row.mustAsk, row.failLine, row.prescribe]) {
    assert.ok(!/\d+\s*(g|克)/i.test(one), '入库的每条都不能带克数：' + one)
  }
  assert.ok(row.failPoints[0].includes('*'), '遮罩要真的动手')

  // 已判的局再判：拒绝覆盖
  const twice = await finish.execute({ id: 'r-1', verdict: '过关' }, { agent: { id: 'doc' } })
  assert.equal(twice.ok, false)
  assert.ok(twice.message.includes('已经判过'))
  assert.equal(store.snapshot().find((r) => r.id === 'r-1').verdict, '不过关', '结论不被覆盖')
  release()
})
