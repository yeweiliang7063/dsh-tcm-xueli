// 会话归档测试：整段会话一份 Markdown、文件名用标题、标题变化改名、只记录本预设。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 测试不碰真家目录：盐、锚点都落在临时目录里。
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-records-home-'))
import {
  anchorDigest,
  answerText,
  appendSeenAnchor,
  clearMutedTurns,
  conversationFromEvents,
  createSessionRecorder,
  dropGearEntry,
  noteMutedTurn,
  readGearState,
  readRecentRounds,
  readSeenAnchors,
  recordSession,
  safeTitle,
  saveGearEntry,
  saveRecentRound,
  ANCHOR_FILE,
  GEAR_FILE,
  RECORD_DIR,
  ROUNDS_FILE,
} from '../lib/records.js'

const at = new Date('2026-11-12T15:30:22+08:00')

function userEvent(text, seq = 1) {
  return {
    type: 'user/message',
    seq,
    time: at.getTime() + seq,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  }
}

function assistantEvent(text, seq = 2) {
  return {
    type: 'assistant/message',
    seq,
    time: at.getTime() + seq,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text }] },
    },
  }
}

test('answerText：只取 text 块，跳过 reasoning 与工具块', () => {
  assert.equal(
    answerText([
      { type: 'reasoning', text: '内部推理，不该出现' },
      { type: 'text', text: '第一段' },
      { type: 'tool-call', id: 'call-1' },
      { type: 'text', text: '第二段' },
    ]),
    '第一段\n\n第二段',
  )
  assert.equal(answerText(undefined), '')
  assert.equal(answerText([{ type: 'reasoning', text: '只有推理' }]), '')
})

test('safeTitle：去掉 Windows 非法字符，空标题退回会话号', () => {
  assert.equal(safeTitle('61岁/高血压:患者?', 'session-abcdef123456'), '61岁 高血压 患者')
  assert.equal(safeTitle('   ', 'session-abcdef123456'), '中医会话-abcdef12')
  assert.equal(safeTitle('x'.repeat(120), 'session-abcdef123456').length, 80)
})

test('safeTitle：撞上 Windows 设备名的标题要加前缀，不然文件根本写不进去', () => {
  assert.equal(safeTitle('CON', 'session-abcdef123456'), '中医会话-CON')
  assert.equal(safeTitle('com3', 'session-abcdef123456'), '中医会话-com3')
  assert.equal(safeTitle('TCM病案', 'session-abcdef123456'), 'TCM病案')
});
test('conversationFromEvents：只收真人发言与助手正文，保持顺序', () => {
  const events = [
    userEvent('后脑勺疼。', 1),
    { type: 'user/message', seq: 2, data: { source: { kind: 'system' }, content: [{ type: 'text', text: '系统提示' }] } },
    assistantEvent('请补脉证。', 3),
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'reasoning', text: '推理' }] } } },
    assistantEvent('柴胡桂枝汤。', 5),
  ]
  assert.deepEqual(conversationFromEvents(events), [
    { role: 'user', text: '后脑勺疼。' },
    { role: 'assistant', text: '请补脉证。' },
    { role: 'assistant', text: '柴胡桂枝汤。' },
  ])
})

test('conversationFromEvents：带图片的提问不能整条丢掉', () => {
  const events = [
    {
      type: 'user/message',
      seq: 1,
      data: {
        source: { kind: 'user' },
        content: [
          { type: 'image', attachment: { name: '处方.jpg' } },
          { type: 'text', text: '点评这张方' },
        ],
      },
    },
    {
      type: 'user/message',
      seq: 2,
      data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: { name: '方.jpg' } }] },
    },
    assistantEvent('先看症状。', 3),
  ]
  assert.deepEqual(conversationFromEvents(events), [
    { role: 'user', text: '[图片]\n点评这张方' },
    { role: 'user', text: '[图片]' },
    { role: 'assistant', text: '先看症状。' },
  ])
})

test('recordSession：一个会话一份文件，文件名用标题，整段对话都写入', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-session-'))
  const sessionId = 'session-abcdef123456'
  const events = [userEvent('后脑勺疼。'), assistantEvent('请补脉证。')]

  const first = recordSession({ kb, sessionId, title: '61岁/高血压患者', events, now: at })
  assert.ok(first)
  assert.ok(first.startsWith(path.join(kb, RECORD_DIR)))
  assert.equal(path.basename(first), '61岁 高血压患者.md')

  const body = fs.readFileSync(first, 'utf8')
  assert.match(body, /^---\n/)
  assert.match(body, /标题: "61岁\/高血压患者"/)
  assert.match(body, /会话: "session-abcdef123456"/)
  assert.match(body, /# 61岁\/高血压患者/)
  assert.match(body, /### 用户\n\n后脑勺疼。/)
  assert.match(body, /### 中医 · 经方\n\n请补脉证。/)

  const second = recordSession({ kb, sessionId, title: '61岁/高血压患者', events, now: new Date(at.getTime() + 1000), previousFile: first })
  assert.equal(second, first, '同一会话、同一标题应覆盖原文件')
  assert.equal(fs.readdirSync(path.join(kb, RECORD_DIR)).length, 1)

  const renamed = recordSession({ kb, sessionId, title: '后脑勺疼（复诊）', events, now: at, previousFile: first })
  assert.notEqual(renamed, first)
  assert.equal(path.basename(renamed), '后脑勺疼（复诊）.md')
  assert.equal(fs.existsSync(first), false, '标题变化后旧文件应删除')
  assert.equal(fs.readdirSync(path.join(kb, RECORD_DIR)).length, 1)
})

test('recordSession：不同会话同名时加序号，不覆盖别人', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-session-'))
  const events = [userEvent('头疼。'), assistantEvent('请补脉证。')]
  const a = recordSession({ kb, sessionId: 'session-aaaa1111', title: '同一个标题', events, now: at })
  const b = recordSession({ kb, sessionId: 'session-bbbb2222', title: '同一个标题', events, now: at })
  assert.equal(path.basename(a), '同一个标题.md')
  assert.equal(path.basename(b), '同一个标题 (2).md')
  assert.equal(fs.readdirSync(path.join(kb, RECORD_DIR)).length, 2)
})

test('recordSession：重启后没记住上一份路径，也能清掉同会话的兜底旧文件', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-session-'))
  const sessionId = 'session-abcdef123456'
  const events = [userEvent('头疼。'), assistantEvent('请补脉证。')]
  const fallback = recordSession({ kb, sessionId, events, now: at })
  assert.equal(path.basename(fallback), '中医会话-abcdef12.md')
  const titled = recordSession({ kb, sessionId, title: '正式标题', events, now: at })
  assert.equal(path.basename(titled), '正式标题.md')
  assert.equal(fs.existsSync(fallback), false)
  assert.deepEqual(fs.readdirSync(path.join(kb, RECORD_DIR)), ['正式标题.md'])
})

test('recordSession：资料库不存在时返回 null，不抛异常', () => {
  const kb = path.join(os.tmpdir(), `qh-missing-${Date.now()}`)
  assert.equal(recordSession({ kb, sessionId: 'x', title: '标题', events: [userEvent('正文')] }), null)
})

test('createSessionRecorder：按当前预设归档整段会话，标题来自会话标题服务', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-recorder-'))
  const infos = []
  const recorder = createSessionRecorder({
    getKb: () => kb,
    currentPreset: (session) => session.projectionPreset,
    getTitle: (session) => session.title,
    logger: { info: (...args) => infos.push(args), warn: () => {} },
  })
  const events = [userEvent('后脑勺疼。'), assistantEvent('请补脉证。')]
  const tcmSession = {
    id: 'session-aaaabbbb',
    header: { agentPreset: 'dsh-tcm-xueli' },
    title: '61岁高血压患者后脑勺疼',
    snapshotEvents: () => events,
  }
  const otherSession = { id: 'session-ccccdddd', header: { agentPreset: 'cordis' } }
  // 先以 cordis 创建、后来在空白会话里切到中医 · 经方：header 仍是 cordis。
  const switchedSession = {
    id: 'session-switched1',
    header: { agentPreset: 'cordis' },
    projectionPreset: 'dsh-tcm-xueli',
    title: '切换预设后的会话',
    snapshotEvents: () => [userEvent('头疼。'), assistantEvent('请补脉证。')],
  }

  recorder(otherSession, assistantEvent('普通编码回答。'))
  assert.equal(fs.existsSync(path.join(kb, RECORD_DIR)), false, '别的预设不能建目录')

  recorder(tcmSession, assistantEvent('柴胡桂枝汤。', 3))
  let files = fs.readdirSync(path.join(kb, RECORD_DIR))
  assert.equal(files.length, 1)
  assert.equal(files[0], '61岁高血压患者后脑勺疼.md')
  const body = fs.readFileSync(path.join(kb, RECORD_DIR, files[0]), 'utf8')
  assert.match(body, /后脑勺疼。/)
  assert.match(body, /请补脉证。/)
  assert.match(body, /柴胡桂枝汤。/)
  assert.ok(infos.length >= 1, '写入成功应记一条日志')

  // 标题服务晚于最后一条回答才生成标题时，session/title 事件要把文件改名。
  events.push(assistantEvent('柴胡桂枝汤。', 3))
  recorder(tcmSession, {
    type: 'session/title',
    seq: 4,
    time: at.getTime() + 4000,
    data: { title: '改后的会话标题' },
  })
  files = fs.readdirSync(path.join(kb, RECORD_DIR))
  assert.deepEqual(files, ['改后的会话标题.md'])
  assert.equal(fs.existsSync(path.join(kb, RECORD_DIR, '61岁高血压患者后脑勺疼.md')), false, '旧标题文件应删除')
  assert.match(fs.readFileSync(path.join(kb, RECORD_DIR, files[0]), 'utf8'), /柴胡桂枝汤。/)

  recorder(switchedSession, assistantEvent('柴胡桂枝汤。', 3))
  files = fs.readdirSync(path.join(kb, RECORD_DIR))
  assert.equal(files.length, 2, 'header 为创建时 cordis 时，应读当前预设投影')
  assert.ok(files.includes('切换预设后的会话.md'))
})

test('createSessionRecorder：模拟问诊局（标题「问诊·局」开头）不归档，改名前的兜底归档也清掉', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-sim-skip-'))
  const recorder = createSessionRecorder({
    getKb: () => kb,
    currentPreset: (session) => session.projectionPreset,
    getTitle: (session) => session.title,
    logger: { info: () => {}, warn: () => {} },
  })
  const simSession = {
    id: 'session-simround1',
    header: { agentPreset: 'dsh-tcm-xueli' },
    title: '问诊·局一',
    snapshotEvents: () => [userEvent('头疼。'), assistantEvent('请补脉证。')],
  }
  recorder(simSession, assistantEvent('请补脉证。', 3))
  assert.equal(fs.existsSync(path.join(kb, RECORD_DIR)), false, '问诊局不该建医案目录')

  // 标题还没生成时先写过一份兜底名归档，随后认出是问诊局：那份兜底归档要被清掉。
  const lateTitle = {
    id: 'session-simround2',
    header: { agentPreset: 'dsh-tcm-xueli' },
    title: undefined,
    snapshotEvents: () => [userEvent('咳嗽。'), assistantEvent('请补脉证。')],
  }
  recorder(lateTitle, assistantEvent('请补脉证。', 3))
  const files = fs.readdirSync(path.join(kb, RECORD_DIR))
  assert.equal(files.length, 1, '标题没生成时先写一份兜底名归档')
  const fallback = path.join(kb, RECORD_DIR, files[0])
  lateTitle.title = '问诊·局二'
  recorder(lateTitle, { type: 'session/title', seq: 4, time: at.getTime() + 4000, data: { title: '问诊·局二' } })
  assert.equal(fs.existsSync(fallback), false, '认出问诊局后兜底归档应删除')
  assert.deepEqual(fs.readdirSync(path.join(kb, RECORD_DIR)), [], '医案里不留问诊记录')
})

test('思考档位存根：记下、读回、清掉；库没设或文件坏了都不炸', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-gear-'))
  assert.deepEqual(readGearState(''), {}, '库没设回空')
  assert.deepEqual(readGearState(kb), {}, '文件还没有回空')

  assert.equal(saveGearEntry(kb, 's-1', 'medium'), true)
  assert.equal(saveGearEntry(kb, 's-2', ''), true, '原来没有档位也记（空串）')
  const state = readGearState(kb)
  assert.equal(state['s-1'].restore, 'medium')
  assert.equal(state['s-2'].restore, '')
  assert.ok(state['s-1'].at > 0, '带时间戳')

  assert.equal(dropGearEntry(kb, 's-1'), true)
  assert.equal(dropGearEntry(kb, 's-1'), false, '清过的再清当没事')
  assert.deepEqual(Object.keys(readGearState(kb)), ['s-2'])

  // 文件坏了：读回空，不抛
  fs.writeFileSync(path.join(kb, RECORD_DIR, GEAR_FILE), '{坏的', 'utf8')
  assert.deepEqual(readGearState(kb), {}, '坏文件回空')
  assert.equal(saveGearEntry(kb, 's-3', 'high'), true, '坏了也能重写')
  assert.equal(readGearState(kb)['s-3'].restore, 'high')
})

test('思考档位存根最多留 50 条，新的挤掉旧的', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-gear-many-'))
  for (let i = 0; i < 60; i += 1) saveGearEntry(kb, 's-' + i, 'low')
  const state = readGearState(kb)
  assert.equal(Object.keys(state).length, 50, '只留 50 条')
  assert.ok(state['s-59'], '最新的在')
  assert.equal(state['s-0'], undefined, '最旧的被挤掉')
})

/* ── 最近几局：锚点只落摘要、旧明文迁移、并发串行、失败不静默 ── */

const digestOf = (text) => anchorDigest(text)

test('最近几局：锚点只落 sha256 短摘要，明文底牌不进医生可读的文件', async () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-rounds-'))
  const anchor = '太阳|表虚|营卫不和|汗出当风'
  const ok = await saveRecentRound(kb, { id: 'r-1', createdAt: 1, level: '普通', direction: '方药', caseSummary: '男 45 岁', anchor })
  assert.equal(ok, true)
  const file = path.join(kb, RECORD_DIR, ROUNDS_FILE)
  const raw = fs.readFileSync(file, 'utf8')
  assert.ok(!raw.includes(anchor), '明文底牌不能落盘')
  assert.ok(raw.includes(digestOf(anchor)), '落的是摘要')
  const rows = readRecentRounds(kb)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].anchor, digestOf(anchor))
  assert.equal(rows[0].caseSummary, '男 45 岁')
})

test('最近几局：旧文件里的明文锚点，读时换摘要并重写一次（迁移）', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-rounds-old-'))
  const dir = path.join(kb, RECORD_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, ROUNDS_FILE)
  const plain = '阳明|腑实|燥结|误下'
  fs.writeFileSync(file, JSON.stringify({ id: 'r-old', anchor: plain }) + '\n', 'utf8')
  const rows = readRecentRounds(kb)
  assert.equal(rows[0].anchor, digestOf(plain), '读回的已是摘要')
  const raw = fs.readFileSync(file, 'utf8')
  assert.ok(!raw.includes(plain), '文件应已重写，明文不留在盘上')
  assert.ok(raw.includes(digestOf(plain)))
  // 再读一次不重复重写（内容稳定）
  assert.deepEqual(readRecentRounds(kb), rows)
})

test('最近几局：并发写入走串行队列不丢行；写失败返回 false 且记日志', async () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-rounds-race-'))
  await Promise.all([1, 2, 3, 4, 5].map((n) => saveRecentRound(kb, { id: 'r-' + n, anchor: '底牌' + n })))
  const rows = readRecentRounds(kb)
  assert.equal(rows.length, 5, '五笔并发一行都不能丢')
  assert.deepEqual(rows.map((one) => one.id), ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'])

  const warns = []
  const badKb = path.join(kb, '这是个文件不是目录')
  fs.writeFileSync(badKb, 'x', 'utf8')
  const ok = await saveRecentRound(badKb, { id: 'r-x' }, { warn: (...args) => warns.push(args) })
  assert.equal(ok, false, '写失败要如实返回 false')
  assert.ok(warns.length >= 1, '写失败要记日志，不能静默')
})

test('最近几局：崩溃残留的跨进程写入锁会被破掉，归档不卡死，用完释放锁', async () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-rounds-lock-'))
  const dir = path.join(kb, RECORD_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, ROUNDS_FILE + '.lock')
  fs.mkdirSync(lock)
  const stale = new Date(Date.now() - 60000)
  fs.utimesSync(lock, stale, stale) // 模拟上个进程崩溃留下的旧锁
  const ok = await saveRecentRound(kb, { id: 'r-lock', createdAt: 1, caseSummary: '题面' })
  assert.equal(ok, true, '残留锁不该把归档永久卡死')
  assert.equal(fs.existsSync(lock), false, '临界区跑完要把锁释放掉')
  assert.equal(readRecentRounds(kb).length, 1, '破锁后数据照常写进去')
  fs.rmSync(kb, { recursive: true, force: true })
})

/* ── 锚点历史：挪进插件私有目录，旧库文件读走合并后删除 ── */

test('锚点历史：存 DSH 家目录的私有目录，旧库文件合并后删掉', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-anchor-home-'))
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-anchor-kb-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = path.join(kb, RECORD_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const oldFile = path.join(dir, ANCHOR_FILE)
    fs.writeFileSync(oldFile, '甲|乙|丙|丁\n戊|己|庚|辛\n', 'utf8')
    // 私有目录里先有一条：迁移要合并去重，不是覆盖
    const privDir = path.join(home, 'dsh-tcm-xueli')
    fs.mkdirSync(privDir, { recursive: true })
    const privFile = path.join(privDir, 'anchors.jsonl')
    fs.writeFileSync(privFile, '戊|己|庚|辛\n壬|癸|子|丑\n', 'utf8')

    assert.deepEqual(readSeenAnchors(kb), ['甲|乙|丙|丁', '戊|己|庚|辛', '壬|癸|子|丑'], '旧内容读走合并，重复的留后面那条')
    assert.equal(fs.existsSync(oldFile), false, '旧文件是插件自产缓存，迁移后应删掉')
    assert.ok(fs.existsSync(privFile), '新文件在私有目录')
    assert.ok(!fs.existsSync(path.join(dir, '最近抽过的锚点.jsonl')), '资料库里不再留锚点文件')

    assert.equal(appendSeenAnchor(kb, '寅|卯|辰|巳'), true)
    assert.deepEqual(readSeenAnchors(kb).slice(-1), ['寅|卯|辰|巳'])
    assert.equal(appendSeenAnchor('', '午|未|申|酉'), true, '没设库也能记（私有目录与库无关）')
    assert.equal(appendSeenAnchor(kb, '   '), false, '空锚点不记')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})

/* ── 闭麦回合：助手正文不进医生可读的归档 ── */

function turnAssistant(text, turn, seq) {
  return {
    type: 'assistant/message',
    seq,
    time: at.getTime() + seq,
    data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
  }
}

test('conversationFromEvents：闭麦回合的助手正文整条跳过，问句与判卷照常', () => {
  const events = [
    userEvent('【模拟问诊 · 开局】普通｜方药｜r-1', 1),
    turnAssistant('底牌推理：这一局锚点是太阳|表虚|营卫不和|汗出当风……', 1, 2),
    userEvent('怕风吗？', 3),
    turnAssistant('（转述病人）怕风，汗出。', 2, 4),
    userEvent('交卷', 5),
    turnAssistant('过关。方证相应。', 3, 6),
  ]
  const list = conversationFromEvents(events, new Set([1]))
  assert.deepEqual(list, [
    { role: 'user', text: '【模拟问诊 · 开局】普通｜方药｜r-1' },
    { role: 'user', text: '怕风吗？' },
    { role: 'assistant', text: '（转述病人）怕风，汗出。' },
    { role: 'user', text: '交卷' },
    { role: 'assistant', text: '过关。方证相应。' },
  ])
  // 不传闭麦集合时行为照旧
  assert.equal(conversationFromEvents(events).length, 6)
})

test('recordSession：noteMutedTurn 标过的回合，正文不进医案；clearMutedTurns 后恢复', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-mute-'))
  const sessionId = 'session-mute0001'
  const events = [
    userEvent('开局', 1),
    turnAssistant('底牌推理：锚点明文不该出现在归档里', 1, 2),
    turnAssistant('判卷：过关。', 2, 3),
  ]
  try {
    noteMutedTurn(sessionId, 1)
    const file = recordSession({ kb, sessionId, title: '闭麦归档', events, now: at })
    assert.ok(file)
    const body = fs.readFileSync(file, 'utf8')
    assert.ok(!body.includes('底牌推理'), '闭麦轮助手正文不能进归档')
    assert.ok(body.includes('判卷：过关。'), '判卷照常')
    assert.ok(body.includes('开局'), '用户发言照常')
  } finally {
    clearMutedTurns(sessionId)
  }
  const again = recordSession({ kb, sessionId, title: '闭麦归档', events, now: at })
  assert.ok(fs.readFileSync(again, 'utf8').includes('底牌推理'), '清掉标记后恢复照常归档')
})

/* ── 删旧档：路径写法差异不误删、换库根不删旧库、正文引用会话号不误认 ── */

test('recordSession：previousFile 换个写法（大小写/斜杠）不能删掉刚写好的新归档', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-samepath-'))
  const sessionId = 'session-abcdef123456'
  const events = [userEvent('头疼。'), assistantEvent('请补脉证。')]
  const first = recordSession({ kb, sessionId, title: '同一个标题', events, now: at })
  assert.ok(first)
  // 用户把路径写法改了：Windows 下小写盘符＋正斜杠，指向同一份文件
  const alt = process.platform === 'win32'
    ? first.toLowerCase().replace(/\\/g, '/')
    : first.replace('/', '/./')
  const second = recordSession({ kb, sessionId, title: '同一个标题', events, now: at, previousFile: alt })
  assert.equal(second, first, '应认出是同一份文件，直接覆盖')
  assert.ok(fs.existsSync(first), '刚写好的新归档不能被当成旧文件删掉')
  assert.equal(fs.readdirSync(path.join(kb, RECORD_DIR)).length, 1)
})

test('recordSession：换了库根，不删旧库里的归档', () => {
  const kb1 = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-kb1-'))
  const kb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-kb2-'))
  const sessionId = 'session-abcdef123456'
  const events = [userEvent('头疼。'), assistantEvent('请补脉证。')]
  const old = recordSession({ kb: kb1, sessionId, title: '同一个标题', events, now: at })
  assert.ok(old)
  const now = recordSession({ kb: kb2, sessionId, title: '同一个标题', events, now: at, previousFile: old })
  assert.ok(now)
  assert.ok(now.startsWith(path.join(kb2, RECORD_DIR)))
  assert.ok(fs.existsSync(old), '旧库的归档不能顺手删掉')
})

test('recordSession：正文里引用别的会话号，不算那一局的文件（只认 frontmatter）', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-frontmatter-'))
  const eventsB = [userEvent('我的编号是 会话: "session-aaaa1111"，记一下。'), assistantEvent('好的。')]
  const fileB = recordSession({ kb, sessionId: 'session-bbbb2222', title: '同一个标题', events: eventsB, now: at })
  assert.ok(fileB)
  const bodyB = fs.readFileSync(fileB, 'utf8')
  assert.ok(bodyB.includes('session-aaaa1111'), '正文确实引用了别人的会话号')
  // 会话 A 用同名标题来写：不能把 B 的文件当成自己的覆盖掉
  const fileA = recordSession({ kb, sessionId: 'session-aaaa1111', title: '同一个标题', events: [userEvent('头疼。'), assistantEvent('请补脉证。')], now: at })
  assert.equal(path.basename(fileA), '同一个标题 (2).md', '应加序号，不覆盖 B')
  assert.equal(fs.readFileSync(fileB, 'utf8'), bodyB, 'B 的文件原样不动')
})

test('createSessionRecorder：子智能体（扮演病人）会话不归档，晚到的子会话标记会把已存副本清掉', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-subagent-skip-'))
  const infos = []
  const recorder = createSessionRecorder({
    getKb: () => kb,
    currentPreset: (session) => session.projectionPreset,
    getTitle: (session) => session.title,
    logger: { info: (...args) => infos.push(args), warn: () => {} },
  })
  const patient = {
    id: 'session-patient001',
    header: { agentPreset: 'dsh-tcm-xueli' },
    title: '子会话测试',
    snapshotEvents: () => [userEvent('病例卡不许泄露。'), assistantEvent('我咳嗽十来天了。')],
  }
  // 第一位：投影还没写子会话标记时先收到事件（按普通会话兜底写了一份）。
  recorder(patient, assistantEvent('我咳嗽十来天了。', 2))
  const dir = path.join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const early = path.join(kb, RECORD_DIR, '子会话测试.md')
  assert.ok(fs.existsSync(early), '标记未落盘前会先兜底归档一份')
  // 子会话标记落盘（DSH 把这个会话记成 subagent）：下一条事件必须认出它，并删掉兜底副本。
  fs.writeFileSync(path.join(dir, patient.id + '.json'), JSON.stringify({
    version: 7,
    record: { rows: { subagent: { val: { identity: { mode: 'continuable', label: '扮演病人', seq: 0 } } } } },
  }))
  recorder(patient, assistantEvent('我咳嗽十来天了。', 3))
  assert.equal(fs.existsSync(early), false, '子会话的归档要被清掉')
  assert.deepEqual(fs.readdirSync(path.join(kb, RECORD_DIR)), [], '医案目录里不留任何病人会话')
})

test('createSessionRecorder：标题是「扮演…病人」的会话即使投影还没标记也不归档', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'qh-roleplay-skip-'))
  const recorder = createSessionRecorder({
    getKb: () => kb,
    currentPreset: (session) => session.projectionPreset,
    getTitle: (session) => session.title,
    logger: { info: () => {}, warn: () => {} },
  })
  const patient = {
    id: 'session-patient002',
    header: { agentPreset: 'dsh-tcm-xueli' },
    title: '扮演咳嗽病人问诊 【中医 · 经方（学习版）】本节仅供学习',
    snapshotEvents: () => [userEvent('病例卡：男，40 岁。'), assistantEvent('我咳嗽十来天了。')],
  }
  recorder(patient, assistantEvent('我咳嗽十来天了。', 2))
  assert.equal(fs.existsSync(path.join(kb, RECORD_DIR)), false, '按标题就该认出是病人会话')
})
