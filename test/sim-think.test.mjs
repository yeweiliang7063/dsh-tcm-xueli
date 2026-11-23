import test from 'node:test'
import assert from 'node:assert/strict'

import { createSimThinker, panelOpen, wantsHandIn, mountSimEndRoute } from '../lib/sim-think.js'

/** 一个假的 agent：记着当前选择，select 时照着改。 */
function fakeAgent(provider, model, effort) {
  const state = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
  return {
    model: {
      current: () => ({ ...state }),
      select: (next) => {
        for (const key of Object.keys(state)) delete state[key]
        Object.assign(state, next)
      },
    },
  }
}

/** 假 ctx：sessionController 给 agent，llm 只认指定的档位。 */
function fakeCtx(agent, accepts, resolveOf) {
  const resolve = typeof resolveOf === 'function' ? resolveOf : (id) => {
    agent.session = { id }
    return agent
  }
  return {
    get(name) {
      if (name === 'sessionController') return { resolveAgent: async (id) => resolve(id) }
      if (name === 'llm') {
        return {
          resolveCallConfig(selection) {
            if (selection.reasoningEffort !== undefined && !accepts.includes(selection.reasoningEffort)) {
              throw new Error('unsupported reasoning effort')
            }
            return selection
          },
        }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
  }
}

const open = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('开局把这一局的思考关掉，交卷再调回原档', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 's-1' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20260101-1'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'off', '开局先关思考')

  // 开局那一轮派病人，医生问一句之后才开始正常转话
  thinker(session, open('请问您头胀多久了？'))

  // 交卷与裁判的思考是同一个回合：必须当场还原，不能等异步。
  thinker(session, open('交卷'))
  assert.equal(agent.model.current().reasoningEffort, 'medium', '交卷当场就回到原来的档位')
})

test('模型不认 off 就往下降一档，不硬塞', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'high')
  const ctx = fakeCtx(agent, ['minimal', 'low', 'high'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })

  thinker({ id: 's-2' }, open('【模拟问诊 · 开局】困难｜针药｜20260101-2'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'minimal', 'off 不认就用 minimal')
})

test('全量版会话一律不动', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'full' })

  thinker({ id: 's-3' }, open('【模拟问诊 · 开局】简单｜方药｜20260101-3'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '全量版不许被这套开关碰')
})

test('这一局的病人子会话也关思考，别局的子会话不管', async () => {
  const patient = fakeAgent('deepseek', 'deepseek-v4', 'high')
  const other = fakeAgent('deepseek', 'deepseek-v4', 'high')
  const ctx = fakeCtx(patient, ['off', 'high'])
  const { thinker, child } = createSimThinker(ctx, { versionOf: () => 'xueli' })

  // 先有一局开局，才认它下面的子会话
  thinker({ id: 'doctor-1' }, open('【模拟问诊 · 开局】普通｜方药｜20260101-4'))
  await tick()

  child({ id: 'patient-1', origin: 'subagent', header: { parentSession: 'doctor-1' } })
  await tick()
  assert.equal(patient.model.current().reasoningEffort, 'off', '病人不用长链思考')

  // 不是这一局派出来的子会话：原样
  const ctx2 = fakeCtx(other, ['off', 'high'])
  const made = createSimThinker(ctx2, { versionOf: () => 'xueli' })
  made.child({ id: 'patient-2', origin: 'subagent', header: { parentSession: 'normal-chat' } })
  await tick()
  assert.equal(other.model.current().reasoningEffort, 'high', '别局的子会话不许动')
})

test('消息没带 source 也认，交卷带个句号也认', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'high')
  const ctx = fakeCtx(agent, ['off', 'high'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 's-9' }

  thinker(session, { type: 'user/message', data: { content: '【模拟问诊 · 开局】简单｜方药｜20260101-9' } })
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'off')

  thinker(session, { type: 'user/message', data: { content: [{ type: 'text', text: '请问大便怎么样？' }] } })
  thinker(session, { type: 'user/message', data: { content: [{ type: 'text', text: '交卷。' }] } })
  assert.equal(agent.model.current().reasoningEffort, 'high', '不能因为多了个标点就不还原')
})

test('只管模拟问诊这一局：普通聊天、没开局的会话一个字都不动', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'high')
  const ctx = fakeCtx(agent, ['off', 'high'])
  const { thinker, settled } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const chat = { id: 'plain-chat' }

  // 没开过局的会话：说什么都不动
  thinker(chat, open('交卷'))
  thinker(chat, open('治法当和解少阳'))
  settled(chat, { type: 'assistant/message' })
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'high', '普通聊天不许被碰')

  // 开了一局，且开局后医生真问了话：这一局才归它管
  thinker({ id: 'sim-1' }, open('【模拟问诊 · 开局】简单｜方药｜20260101-30'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'off')
  thinker({ id: 'sim-1' }, open('请问口干吗？'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'off', '这一局还在问诊中，思考要继续关着')

  // 交完卷这一局就结束了，之后再聊不再动它
  thinker({ id: 'sim-1' }, open('交卷'))
  assert.equal(agent.model.current().reasoningEffort, 'high')
  settled({ id: 'sim-1' }, { type: 'assistant/message' })
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'high', '交完卷就不再管')
})

test('闭嘴只认「答卷」两个字：开局与问话都不闭嘴，写了「答卷」才闭', () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'sim-q' }
  const say = (text, kind) => thinker(session, { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })

  say('【模拟问诊 · 开局】普通｜方药｜20261121-1', 'user')
  assert.equal(quietOf('sim-q'), true, '开局这一轮也不许说话，只许派病人')
  say('请问您头晕多久了？', 'user')
  assert.equal(quietOf('sim-q'), false, '问话不闭嘴')
  say('口干口苦，脉弦，治法和解少阳，主方小柴胡汤。', 'user')
  assert.equal(quietOf('sim-q'), false, '没写「答卷」两个字，不算开始答卷')
  say('子智能体已完成任务', 'subagent-settled')
  assert.equal(quietOf('sim-q'), false, '通知也不闭嘴')
})

test('医生打「答卷」才开始闭嘴；再提问安全解锁，交卷收尾', () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'sim-ask' }
  const say = (text) => thinker(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

  say('【模拟问诊 · 开局】普通｜方药｜20261121-1')
  assert.equal(quietOf('sim-ask'), true, '开局这一轮只许派病人，正文闭嘴')
  say('请问口苦吗？')
  assert.equal(quietOf('sim-ask'), false, '医生第一次开口，病人要能被叫来')
  say('答卷：口干口苦，脉弦，少阳证，治法和解少阳，主方小柴胡汤。')
  assert.equal(quietOf('sim-ask'), true, '看到「答卷」两个字就闭嘴')
  say('那要是只和解不换方呢？')
  assert.equal(quietOf('sim-ask'), false, '安全解锁：闭麦后医生再提问必须放开，否则整局卡死只有交卷能解')
  say('答卷补充：仍主小柴胡汤。')
  assert.equal(quietOf('sim-ask'), true, '再答一轮又闭嘴')
  say('交卷')
  assert.equal(quietOf('sim-ask'), false, '交卷放开')
})

test('诊室面板代发的开局：只许派病人，正文闭嘴', () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'sim-source' }
  thinker(session, { type: 'user/message', data: { source: { kind: 'tcmXueliSim' }, content: [{ type: 'text', text: '【模拟问诊 · 开局】普通｜针药｜20261121-182549' }] } })
  assert.equal(quietOf('sim-source'), true, '开局这一轮正文闭嘴，免得自己念病例卡')
  thinker(session, { type: 'user/message', data: { source: { kind: 'tcmXueliSim' }, content: [{ type: 'text', text: '请问您怕冷还是怕热？' }] } })
  assert.equal(quietOf('sim-source'), false, '医生真问了，就放开')
})

test('开局那句话不看预设也认；「交卷」要整句恰好才算，句中提到不算', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => '' })
  const session = { id: 'sim-no-preset' }

  thinker(session, open('【模拟问诊 · 开局】困难｜针药｜20261121-1'))
  thinker(session, open('请问您头晕吗？'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'off', '预设还没挂上也要关思考')
  thinker(session, open('这一局我看完了，交卷吧。'))
  assert.equal(agent.model.current().reasoningEffort, 'off', '句中提到「交卷」不算交卷，思考保持关')
  thinker(session, open('交卷'))
  assert.equal(agent.model.current().reasoningEffort, 'medium', '整句恰好是「交卷」才还原')
})

test('开局之后第一句就是「交卷」也认：当场开到 High，这一局收尾', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'sim-first-handin' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261121-77'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'off')

  thinker(session, open('交卷'))
  assert.equal(agent.model.current().reasoningEffort, 'high', '第一句就是交卷，也要开 High')
  assert.equal(quietOf('sim-first-handin'), false, '交卷这一轮要放开')
})

test('开局之后第一句就是「答卷」：直接闭嘴，不白放一轮', () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'sim-first-daanjuan' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261121-78'))
  thinker(session, open('答卷：口干口苦，少阳证，小柴胡汤。'))
  assert.equal(quietOf('sim-first-daanjuan'), true, '第一句答卷就要闭嘴，不能白放过去')
})

test('普通会话里问一句「模拟问诊怎么开始」不算开局', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'plain-mention' }

  thinker(session, open('模拟问诊怎么开始？'))
  thinker(session, open('【模拟问诊】这功能有点意思'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '只是提到这几个字，不许当开局')
  assert.equal(quietOf('plain-mention'), false, '也不许把这一轮正文清空')
})

test('点评打完再把档位交回去：下一句闲聊不再跑 High', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'sim-after' }

  thinker(session, open('【模拟问诊 · 开局】简单｜方药｜20261121-79'))
  await tick()
  thinker(session, open('请问怕冷吗？'))
  thinker(session, open('交卷'))
  assert.equal(agent.model.current().reasoningEffort, 'high', '点评这一轮要 High')

  // 点评打完了，医生换话题：档位交回原来的 medium
  thinker(session, open('谢谢，今天就到这儿'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '点评完要把档位交回去，别一直 High')
})

test('拿到的 agent 不属于这一局（全量版/普通聊天的）就不碰', async () => {
  const other = fakeAgent('deepseek', 'deepseek-v4', 'high')
  other.session = { id: 'full-version-chat' }
  const ctx = fakeCtx(other, ['off', 'high'], () => other)
  const { thinker, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'sim-scope' }

  thinker(session, open('【模拟问诊 · 开局】简单｜方药｜20261121-9'))
  await tick()
  assert.equal(other.model.current().reasoningEffort, 'high', '别的会话的思考一个字都不许动')
  assert.equal(quietOf('sim-scope'), true, '闭嘴只认这一局，照旧')
})

test('打赏全链路：局号≠会话号，满十局按会话号标记，评完那一刻才认领', async () => {
  const { createStore } = await import('../lib/clinic.js')
  const store = createStore()
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const { thinker, giftDue } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    // 与 sim.js 的真实接线一致：giftOf 只问布尔（hasGift），认领在出口层 takeGift。
    giftOf: (sessionId) => store.hasGift(sessionId),
  })
  const finish = { type: 'tool/result', data: { name: 'xueli_finish_round', ok: true } }

  // 前九局：局号（round-N）与会话号（session-doctor-N）是两回事
  const doctor = { id: 'session-doctor-9' }
  for (let i = 1; i <= 9; i += 1) {
    await store.begin({ id: 'round-' + i, level: '普通', direction: '方药', doctorId: doctor.id })
    await store.end({ id: 'round-' + i, verdict: '过关', doctorId: doctor.id })
  }
  thinker(doctor, open('【模拟问诊 · 开局】普通｜方药｜20260101-9'))
  await tick()
  assert.equal(giftDue(doctor.id), false, '开局不摆')
  thinker(doctor, open('请问您头胀多久了？'))
  thinker(doctor, open('交卷'))
  await tick()
  assert.equal(giftDue(doctor.id), false, '交卷那一份（点评还没记完）不摆')
  thinker(doctor, finish)
  assert.equal(giftDue(doctor.id), false, '不满十局，评完也不摆')
  assert.equal(store.takeGift(doctor.id), null, '不满十局没得领')

  // 第十局（面板另开的新会话）：判完就把这一会话标记为待摆
  const doctor10 = { id: 'session-doctor-10' }
  await store.begin({ id: 'round-10', level: '普通', direction: '方药', doctorId: doctor10.id })
  await store.end({ id: 'round-10', verdict: '过关', doctorId: doctor10.id })
  assert.equal(store.hasGift('round-10'), false, '标记的是会话号，不是局号')
  assert.equal(store.hasGift(doctor10.id), true, '满十局：按会话号标记')
  thinker(doctor10, open('【模拟问诊 · 开局】普通｜方药｜20260101-10'))
  await tick()
  thinker(doctor10, open('请问您口苦吗？'))
  thinker(doctor10, open('交卷'))
  await tick()
  thinker(doctor10, finish)
  assert.equal(giftDue(doctor10.id), true, '评完那一刻按会话号认领到')
  assert.equal(giftDue(doctor10.id), false, '同一轮只认领一次')
  assert.equal(giftDue('round-10'), false, '拿局号来问一律没有')
  assert.equal(giftDue(doctor.id), false, '别的会话不沾')
  assert.deepEqual(store.takeGift(doctor10.id), { rounds: 10 }, '出口层按会话号领到计数')
  assert.equal(store.takeGift(doctor10.id), null, '领完就清')
})

test('panelOpen 只认面板格式：三段齐全才算', () => {
  assert.equal(panelOpen('【模拟问诊 · 开局】普通｜方药｜20261121-1'), true)
  assert.equal(panelOpen('【模拟问诊 · 开局】普通｜方药'), false, '缺局号不算')
  assert.equal(panelOpen('【模拟问诊 · 开局】普通｜方药｜'), false, '局号空不算')
  assert.equal(panelOpen('【模拟问诊 · 开局】'), false, '只有开头不算')
  assert.equal(panelOpen('模拟问诊 · 开局】普通｜方药｜20261121-1'), false, '开头不固定不算')
  assert.equal(panelOpen('请帮我【模拟问诊 · 开局】普通｜方药｜20261121-1'), false, '不在开头不算')
})

test('手打开局（没有局号）只走协议：闭嘴照旧，思考档位一个字不碰', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const { thinker, child, quietOf } = createSimThinker(ctx, { versionOf: () => 'xueli' })
  const session = { id: 'manual-open' }

  thinker(session, open('【模拟问诊 · 开局】'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '主聊天里手打开局，不许动思考')
  assert.equal(quietOf('manual-open'), true, '协议照走：开局这一轮正文闭嘴')

  // 手开的局派出去的子会话也不压
  child({ id: 'patient-m', origin: 'subagent', header: { parentSession: 'manual-open' } })
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '子会话也不碰')

  thinker(session, open('请问您怕冷吗？'))
  thinker(session, open('交卷'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '交卷也不动：本来就没压过')
})

test('面板弃局（release）：档位当场还回去，病人也还，闭嘴清掉', async () => {
  const doctor = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const patient = fakeAgent('deepseek', 'deepseek-v4', 'high')
  const ctx = fakeCtx(doctor, ['off', 'minimal', 'low', 'medium', 'high'], (id) => {
    const agent = id === 'patient-x' ? patient : doctor
    agent.session = { id }
    return agent
  })
  const dropped = []
  const { thinker, child, quietOf, release } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    gearSave: () => {},
    gearDrop: (id) => dropped.push(id),
  })

  thinker({ id: 'doctor-x' }, open('【模拟问诊 · 开局】普通｜方药｜20261121-2'))
  await tick()
  child({ id: 'patient-x', origin: 'subagent', header: { parentSession: 'doctor-x' } })
  await tick()
  assert.equal(doctor.model.current().reasoningEffort, 'off', '面板局开局压最低')
  assert.equal(patient.model.current().reasoningEffort, 'off', '病人也压最低')
  assert.equal(quietOf('doctor-x'), true)

  release('doctor-x')
  await tick()
  assert.equal(doctor.model.current().reasoningEffort, 'medium', '弃局当场还原')
  assert.equal(patient.model.current().reasoningEffort, 'high', '病人的档位也还回去')
  assert.equal(quietOf('doctor-x'), false, '闭嘴登记清掉')
  assert.ok(dropped.includes('doctor-x') && dropped.includes('patient-x'), '存根清掉')

  // 弃局之后再聊天：不再管
  thinker({ id: 'doctor-x' }, open('随便聊点别的'))
  await tick()
  assert.equal(doctor.model.current().reasoningEffort, 'medium', '还回去就不再碰')
})

test('重启后照存根还档位：新实例见到旧会话的动静就还，只还一次', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'off')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
  const dropped = []
  const saved = { 'old-round': { restore: 'medium', at: 1 } }
  const { thinker } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    gearLoad: () => saved,
    gearDrop: (id) => { dropped.push(id); delete saved[id] },
  })

  // 重启后第一句随便什么话：照存根把 off 还回 medium
  thinker({ id: 'old-round' }, open('今天天气不错'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '重启前压低的档位还回去')
  assert.deepEqual(dropped, ['old-round'], '存根清掉')

  // 还过一次就不再管：模型自己开思考也不压
  agent.model.select({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
  thinker({ id: 'old-round' }, open('再聊一句'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'high', '没开过局的会话不碰')
})

test('病人的调低还在路上就弃局：晚到的调低自己收手，原档不被误清', async () => {
  const doctor = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const patient = fakeAgent('deepseek', 'deepseek-v4', 'high')
  const ctx = fakeCtx(doctor, ['off', 'minimal', 'low', 'medium', 'high'], (id) => {
    const agent = id === 'patient-race' ? patient : doctor
    agent.session = { id }
    return agent
  })
  const { thinker, child, release } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    gearSave: () => {},
    gearDrop: () => {},
  })

  thinker({ id: 'doctor-race' }, open('【模拟问诊 · 开局】普通｜方药｜20261121-4'))
  child({ id: 'patient-race', origin: 'subagent', header: { parentSession: 'doctor-race' } })
  // 调低还在路上就弃局：晚到的调低要自己收手，还原也不许把原档误清成默认
  release('doctor-race')
  await tick()
  assert.equal(patient.model.current().reasoningEffort, 'high', '病人原档保住')
  assert.equal(doctor.model.current().reasoningEffort, 'medium', '医生原档保住')
})

test('调低前把原档写进存根，点评打完清掉', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const saved = {}
  const { thinker } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    gearLoad: () => ({}),
    gearSave: (id, restore) => { saved[id] = restore },
    gearDrop: (id) => { delete saved[id] },
  })
  const session = { id: 's-stub' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261121-3'))
  await tick()
  assert.equal(saved['s-stub'], 'medium', '原档记下来了')

  thinker(session, open('请问口苦吗？'))
  thinker(session, open('交卷'))
  thinker(session, { type: 'tool/result', data: { name: 'xueli_finish_round', ok: true } })
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'medium', '点评打完交回原档')
  assert.equal(Object.keys(saved).length, 0, '存根用完即清')
})

test('点评说完就把这一局锁上：判完那一回合收尾才归档，锁完不再重复收', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const archived = []
  const { thinker } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    archiveOf: (id) => { archived.push(id) },
  })
  const session = { id: 's-lock' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261122-9'))
  await tick()
  thinker(session, open('交卷'))
  thinker(session, { type: 'tool/result', data: { name: 'xueli_finish_round', ok: true } })
  assert.deepEqual(archived, [], '判卷那一刻点评还没写，这时收会把点评闸死')
  thinker(session, { type: 'turn/end', data: { turn: 3, reason: 'complete' } })
  assert.deepEqual(archived, ['s-lock'], '点评整段说完就锁成只读')
  thinker(session, open('这一局我再看两眼'))
  thinker(session, { type: 'turn/end', data: { turn: 4, reason: 'complete' } })
  assert.deepEqual(archived, ['s-lock'], '锁过一次就不再重复收')
})

test('弃局后晚到的回合收尾也不收局', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const archived = []
  const { thinker, release } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    archiveOf: (id) => { archived.push(id) },
  })
  const session = { id: 's-drop' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261122-4'))
  await tick()
  thinker(session, open('交卷'))
  thinker(session, { type: 'tool/result', data: { name: 'xueli_finish_round', ok: true } })
  release('s-drop')
  thinker(session, { type: 'turn/end', data: { turn: 2, reason: 'complete' } })
  assert.deepEqual(archived, [], '弃局交给面板（那边会删），开关不再补一刀')
})

test('主聊天里手打的局：点评完也不收、不锁，更不许当成面板的局删掉', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const archived = []
  const { thinker, isPanelRound } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    archiveOf: (id) => { archived.push(id) },
  })
  const session = { id: 's-hand' }

  // 没有局号：这是主聊天里手打开的一局。
  thinker(session, open('【模拟问诊 · 开局】普通｜方药'))
  await tick()
  thinker(session, open('交卷'))
  thinker(session, { type: 'tool/result', data: { name: 'xueli_finish_round', ok: true } })
  thinker(session, { type: 'turn/end', data: { turn: 3, reason: 'complete' } })
  assert.deepEqual(archived, [], '手打的局点评完不收：主聊天的历史不能被收走')
  assert.equal(isPanelRound('s-hand'), false, '手打的局不是面板的，删除通道不许认')
  assert.equal(agent.model.current().reasoningEffort, 'medium', '手打的局连思考档位都不碰')
})

test('面板开的局：认领之后一直认得出，弃局归档了也认得出', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const { thinker, release, isPanelRound } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    archiveOf: () => {},
  })
  const session = { id: 's-panel' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261122-7'))
  assert.equal(isPanelRound('s-panel'), true, '面板开的局要认领')
  release('s-panel')
  assert.equal(isPanelRound('s-panel'), true, '弃局归档之后也得认得出，面板关掉时才删得掉')
  assert.equal(isPanelRound('s-other'), false, '别的会话一概不认')
  assert.equal(isPanelRound(''), false)
  assert.equal(isPanelRound(undefined), false)
})

/* ── 交卷认法：整句精确匹配 ── */

test('wantsHandIn 整句精确：恰好「交卷」（可带少量标点）才认，句中提到不算', () => {
  assert.equal(wantsHandIn('交卷'), true)
  assert.equal(wantsHandIn('交卷。'), true)
  assert.equal(wantsHandIn('  交卷！  '), true)
  assert.equal(wantsHandIn('交卷？'), true)
  assert.equal(wantsHandIn('交卷，'), true)
  assert.equal(wantsHandIn('这一局我看完了，交卷吧。'), false, '句中提到不算')
  assert.equal(wantsHandIn('等会儿交卷'), false)
  assert.equal(wantsHandIn('交卷前再问一句'), false)
  assert.equal(wantsHandIn('答卷'), false)
  assert.equal(wantsHandIn(''), false)
  assert.equal(wantsHandIn(undefined), false)
})

/* ── tool/result 认交卷：结构化字段优先，read/grep 结果不得误触发 ── */

test('tool/result 按 callId 配对 tool/call 认工具：read 读回含该词的源码不算交卷', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const archived = []
  const { thinker, giftDue } = createSimThinker(ctx, {
    versionOf: () => 'xueli',
    archiveOf: (id) => archived.push(id),
    giftOf: () => true,
  })
  const session = { id: 's-toolname' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261123-1'))
  await tick()
  thinker(session, open('交卷'))
  await tick()
  assert.equal(agent.model.current().reasoningEffort, 'high', '交卷后点评要 High')

  // read 工具读回了含「xueli_finish_round」的源码/日志：结构化名字是 read，绝不判交卷
  thinker(session, { type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-read-1', name: 'read', arguments: { file_path: 'lib/clinic.js' } } })
  thinker(session, {
    type: 'tool/result',
    data: {
      turn: 2, step: 1,
      message: { id: 'm1', role: 'tool', toolCallId: 'call-read-1', source: { kind: 'tool', callId: 'call-read-1' }, content: [{ type: 'text', text: '源码里写着 xueli_finish_round 这个工具名' }] },
    },
  })
  assert.equal(agent.model.current().reasoningEffort, 'high', 'read 结果不算交卷，档位不动')
  assert.equal(giftDue('s-toolname'), false, 'read 结果不摆打赏')
  assert.deepEqual(archived, [], 'read 结果不收局')

  // 真正的 xueli_finish_round：callId 配对上名字，判交卷
  thinker(session, { type: 'tool/call', data: { turn: 2, step: 2, callId: 'call-finish-1', name: 'xueli_finish_round', arguments: { id: 'r-1', verdict: '过关' } } })
  thinker(session, {
    type: 'tool/result',
    data: {
      turn: 2, step: 2,
      message: { id: 'm2', role: 'tool', toolCallId: 'call-finish-1', source: { kind: 'tool', callId: 'call-finish-1' }, content: [{ type: 'text', text: '这一局的成绩已记下。' }] },
    },
  })
  assert.equal(giftDue('s-toolname'), true, '配对上名字才认领打赏')
  thinker(session, { type: 'turn/end', data: { turn: 2, reason: 'complete' } })
  assert.deepEqual(archived, ['s-toolname'], '真正的交卷结果才收局')
})

test('tool/result 结构化全缺才退回文本：剔掉正文后只认名字字段，read 正文不误触发', async () => {
  const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
  const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium', 'high'])
  const { thinker, giftDue } = createSimThinker(ctx, { versionOf: () => 'xueli', giftOf: () => true })
  const session = { id: 's-fallback' }

  thinker(session, open('【模拟问诊 · 开局】普通｜方药｜20261123-2'))
  await tick()
  thinker(session, open('交卷'))
  await tick()

  // 没有 callId 配对、没有名字字段，正文里提到该词：不算（正文被剔掉）
  thinker(session, {
    type: 'tool/result',
    data: { turn: 2, step: 1, message: { id: 'm1', role: 'tool', content: [{ type: 'text', text: '日志里出现 xueli_finish_round' }] } },
  })
  assert.equal(giftDue('s-fallback'), false, '正文里提到不算')

  // 名字字段在（简化形态）：算
  thinker(session, { type: 'tool/result', data: { name: 'xueli_finish_round', ok: true } })
  assert.equal(giftDue('s-fallback'), true, '名字字段明确才算')
})

/* ── 闭麦回合打标：助手正文不进医生可读的归档 ── */

test('闭麦轮助手正文不进归档：thinker 打标，recordSession 跳过；问句轮照常归档', async () => {
  const { recordSession, clearMutedTurns } = await import('../lib/records.js')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-mute-'))
  try {
    const agent = fakeAgent('deepseek', 'deepseek-v4', 'medium')
    const ctx = fakeCtx(agent, ['off', 'minimal', 'low', 'medium'])
    const { thinker } = createSimThinker(ctx, { versionOf: () => 'xueli' })
    const session = { id: 'sim-mute-archive' }
    const userEvent = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
    const assistantEvent = (text, turn) => ({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text }] } } })

    // 开局这一轮闭麦：助手正文（底牌推理）不许进归档
    thinker(session, { type: 'turn/start', data: { turn: 1 } })
    thinker(session, userEvent('【模拟问诊 · 开局】普通｜方药｜20261123-3'))
    const events = [
      userEvent('【模拟问诊 · 开局】普通｜方药｜20261123-3'),
      assistantEvent('底牌推理：本局锚点是少阳，病机是胆胃不和……', 1),
    ]
    const file = recordSession({ kb, sessionId: session.id, preset: 'dsh-tcm-xueli', title: '问诊·局 3', events })
    assert.ok(file, '归档要写出来')
    const written = fs.readFileSync(file, 'utf8')
    assert.ok(!written.includes('底牌推理'), '闭麦轮的助手正文不许进归档')
    assert.ok(written.includes('【模拟问诊 · 开局】'), '医生自己的话照常归档')

    // 问句这一轮放开：助手转述照常进归档
    thinker(session, { type: 'turn/start', data: { turn: 2 } })
    thinker(session, userEvent('请问您口苦吗？'))
    events.push(userEvent('请问您口苦吗？'))
    events.push(assistantEvent('病人说：口苦，咽干。', 2))
    const file2 = recordSession({ kb, sessionId: session.id, preset: 'dsh-tcm-xueli', title: '问诊·局 3', events, previousFile: file })
    assert.ok(file2)
    const written2 = fs.readFileSync(file2, 'utf8')
    assert.ok(written2.includes('病人说：口苦，咽干。'), '放开轮的助手正文照常归档')
    assert.ok(!written2.includes('底牌推理'), '重写归档仍跳过闭麦轮')
    clearMutedTurns(session.id)
  } finally {
    fs.rmSync(kb, { recursive: true, force: true })
  }
})

/* ── 弃局通道的本机 CSRF 闸 ── */

test('弃局通道只认本机页面：evil Origin/Referer 拒，GUI 来源过，双缺看 Fetch Metadata，远程拒', async () => {
  let handler = null
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (route) => { handler = route.handler; return () => {} } } : undefined),
    logger: { info() {}, warn() {} },
  }
  const released = []
  const purged = []
  await mountSimEndRoute(ctx, { release: (id) => released.push(id), purge: (id) => purged.push(id) })
  assert.ok(handler, '通道要挂上')
  const call = (headers, remote = '127.0.0.1') => {
    let code = 0
    const res = { writeHead: (c) => { code = c }, end: () => {} }
    handler({ method: 'GET', url: '/dsh-tcm-xueli/sim-end?purge=1&session=s-x', headers, socket: { remoteAddress: remote } }, res)
    return code
  }
  assert.equal(call({ host: '127.0.0.1:57443', origin: 'http://evil.example' }), 403, 'evil Origin 拒')
  assert.equal(call({ host: '127.0.0.1:57443', referer: 'http://evil.example/x' }), 403, 'evil Referer 拒')
  assert.equal(call({ host: '127.0.0.1:57443', origin: 'null' }), 403, '沙箱页 null Origin 拒')
  assert.equal(call({ host: '127.0.0.1:57443', referer: 'http://127.0.0.1:57443/' }), 200, 'GUI 本站 Referer 过')
  assert.equal(call({ host: '127.0.0.1:57443', origin: 'http://localhost:57443' }), 200, 'GUI 本站 Origin 过')
  assert.equal(call({ host: '127.0.0.1:57443', 'sec-fetch-site': 'same-origin' }), 200, '双缺＋同源 fetch 放行')
  assert.equal(call({ host: '127.0.0.1:57443' }, '192.168.1.5'), 403, '远程拒')
  assert.equal(released.length, 3, '只有放行的请求才真弃局')
  assert.equal(purged.length, 3, '只有放行的请求才真删')
})
