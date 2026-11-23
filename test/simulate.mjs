// 插件加载模拟（不启动 DSH 主体）：用假 ctx 走一遍 apply，检查这几件事：
// 1. 两个提示词变量齐全，常驻口径有内容；
// 2. 出口校验只把剂量数值遮成 *，且只对中医会话生效；
// 3. 病例卡工具真的注册进宿主工具服务（假 ctx 补齐 tools/webServer/inject，不再是 get 全空）；
//    顺带验 fix11：真实 cordis inject 作用域读 .disposed 会抛，包了 try/catch 后工具照样装上、不误报「没装」；
// 4. 打赏全链路（fix3）：局号≠会话号，判满十局按会话号标记，点评那一份回答末尾才摆一次，认领一次就清；
// 5. 闭麦（fix16）：闭麦轮 text-delta 清掉、block-end 里的全文也清空（宿主按 block-end 整块替换），块一个不丢；
// 6. 同一目录只挂一份监视：后加载的实例共用已挂的监视，先加载的一方释放后，后加载的仍正常；
// 7. 启动后补书、建索引、建分类文件夹，且不往资料库写规程。
// 覆盖范围如实说明：思考档位的真实升降依赖宿主 sessionController/llm，这里只给空壳，
//   故不验档位数值本身，只验「开局→交卷→判卷工具结果」这条事件链能把打赏标记送到出口。
// 用法：node test/simulate.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const gear = await import(new URL('../lib/gear.js', import.meta.url).href)

// 锚点历史、待清名单都落在 DSH 家目录下的插件私有目录：模拟时指到临时目录，别碰用户真实的 ~/.dsh。
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-simulate-home-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = homeDir

/**
 * 造一个假 ctx：记录变量、事件与清理钩子，并补齐工具/网页服务与 inject 作用域。
 * disposedThrows=true 时，inject 出来的作用域读 .disposed 会抛——照真实 cordis 的样子，
 * 用来验 fix11：读不到就按未卸载处理，工具照样装上。
 */
function makeCtx({ disposedThrows = false } = {}) {
  const logs = []
  const handlers = new Map()
  const variables = new Map()
  const tools = new Map()
  const routes = []
  const cleanups = []
  const services = {
    tools: {
      register: (def) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    // 档位升降要用的服务给个空壳：resolveAgent 返回 null，开关就不动真实档位（本模拟不验档位数值）。
    sessionController: { resolveAgent: async () => null },
  }
  const emit = (event, ...args) => {
    for (const handler of [...(handlers.get(event) || [])]) handler(...args)
  }
  const base = {
    logger: {
      info: (...a) => logs.push(['info', a.map(String).join(' | ')]),
      warn: (...a) => logs.push(['warn', a.map(String).join(' | ')]),
    },
    systemPrompt: { variable: (name, get) => variables.set(name, get) },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const arr = handlers.get(event) || []
        const i = arr.indexOf(handler)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get: (name) => services[name],
    inject: (deps, callback) => {
      const scoped = {
        logger: base.logger,
        get: base.get,
        on: base.on,
        effect: base.effect,
        get disposed() {
          if (disposedThrows) throw new Error('cannot get property "disposed" without inject')
          return false
        },
      }
      callback(scoped)
    },
  }
  return { logs, handlers, variables, tools, routes, cleanups, emit, ctx: base }
}

// ── 预设文件：口径锁在提示词最前面，且按常驻变量切换 ──
const rows = YAML.parseDocument(fs.readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8').replace(/!!js\s+/g, '')).toJS()[0].insert
const presetRow = rows.find((r) => r.id === 'preset-tcm')
const presetPrefix = presetRow.config.plugins[0].config.prefix
assert.ok(presetPrefix.trimStart().startsWith('{{tcm_gear_guard}}'), '预设提示词应以常驻口径变量开头')
// 口径正文只在 GEAR_GUARD 里维护一份，预设里用变量展开；这里查的是那份唯一的正文。
for (const keyword of ['剂量：不自己给量', '不出处方笺', '针灸只给推荐穴位', '不写进针深浅', '配伍禁忌必说', '药典用量警示必说', '复杂病症分主次必说', '学理模式七段作答']) {
  assert.ok(gear.GEAR_GUARD.includes(keyword), `常驻口径缺「${keyword}」`)
}

// ── 起一个临时资料库 ──
const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-simulate-kb-'))
const settings = { kbPath: { get: () => kbDir }, autoIndex: { get: () => true } }

// 第一个实例就用「读 .disposed 会抛」的作用域（fix11 回归）：工具仍要装上、不误报「没装」。
const first = makeCtx({ disposedThrows: true })
mod.apply(first.ctx, settings)
assert.equal(mod.currentPath(settings), path.resolve(kbDir).replace(/[\\/]+$/, ''))

// ── 检查 1：提示词变量 ──
for (const name of [gear.KB_PATH_VAR, gear.GEAR_GUARD_VAR]) {
  assert.ok(first.variables.has(name), `缺少变量 ${name}`)
}
assert.equal(first.variables.get(gear.GEAR_GUARD_VAR)(), gear.GEAR_GUARD, '常驻口径应等于口径锁')
assert.equal(first.variables.get(gear.KB_PATH_VAR)(), path.resolve(kbDir), '资料库变量应给出设置里那个目录的绝对路径')

// ── 检查 2：出口校验 ──
const inspect = (first.handlers.get('llm/stream') || [])[0]
assert.ok(typeof inspect === 'function', '应注册 llm/stream 校验')

// 中医会话靠提示词识别：system 里带常驻口径的第一行即可。
const TCM_SYSTEM = gear.GEAR_GUARD.slice(0, gear.GEAR_GUARD.indexOf(String.fromCharCode(10)))

// 宿主的流是 chunk 对象（text-delta 之类），不是裸字符串；这里照宿主的样子喂。
async function run(answer, options = {}) {
  const out = []
  const upstream = async function* () {
    for (const piece of answer) yield { type: 'text-delta', index: 0, text: piece }
    yield { type: 'finish' }
  }
  for await (const chunk of inspect(options, upstream)) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out.push(chunk.text)
  }
  return out.join('')
}

// 收全部出口块（验闭麦的 block-end 全文要用）。
async function collect(options, chunks) {
  const out = []
  const upstream = async function* () { for (const c of chunks) yield c }
  for await (const chunk of inspect(options, upstream)) out.push(chunk)
  return out
}

const masked = await run(['柴胡证以', '少阳为主。', '若用柴胡，一两折 15.6 克。'], { system: TCM_SYSTEM })
assert.ok(!masked.includes('15.6 克'), '剂量不应漏出')
assert.ok(masked.includes('一两折 *'), '只把数值遮成 *，量词与药名留下')
assert.ok(masked.includes('柴胡证以'), '正文应保留')

const passedOut = await collect({ system: TCM_SYSTEM }, [
  { type: 'text-delta', index: 0, text: '少阳病，' },
  { type: 'text-delta', index: 0, text: '主证为往来寒热。' },
  { type: 'finish' },
])
// 学习版收尾会给中医会话补「免责声明＋打赏区」，那是单独一块、含 markdown 加粗的 *，属合法追加；
// 这里只查正文本身有没有被误遮，末尾补块（含声明识重词或打赏话术）排除在外。
const isTail = (t) => t.includes('本节仅供学习研究') || t.includes('请作者喝杯茶') || t.includes('AI 有幻觉')
const passedBody = passedOut.filter((c) => c.type === 'text-delta' && !isTail(c.text)).map((c) => c.text).join('')
assert.ok(passedBody.includes('往来寒热'), '正常回答应原样放行')
assert.ok(!passedBody.includes('*'), '没有剂量就不该出现 *（正文本身，不含末尾补的声明/打赏）')

const other = await run(['若用柴胡，一两折 15.6 克。'], { system: '你是通用助手，负责回答技术问题。' })
assert.ok(other.includes('15.6 克'), '非中医会话一个字节都不该动')

// ── 检查 3：病例卡工具真的注册进宿主工具服务（fix15＋fix11）──
// 注册走 Promise 微任务，等一下再查。
await new Promise((r) => setTimeout(r, 80))
for (const name of ['xueli_draw_anchor', 'xueli_begin_round', 'xueli_finish_round', 'xueli_list_rounds']) {
  assert.ok(first.tools.has(name), `工具 ${name} 应注册进宿主工具服务`)
}
// fix11：作用域读 .disposed 抛了，也不该误报「工具没装」。
const notMounted = first.logs.filter(([, text]) => text.includes('问诊记录工具没装'))
assert.equal(notMounted.length, 0, `读 .disposed 抛错不应误报工具没装：${notMounted.map((w) => w[1]).join(' ;; ')}`)

// ── 检查 4：打赏全链路（fix3，局号≠会话号）──
const begin = first.tools.get('xueli_begin_round')
const finish = first.tools.get('xueli_finish_round')
const doctor = 'session-doctor-gift'
// 前十局直接走工具：局号 sim-r-N 与会话号 session-doctor-gift 不同。
for (let i = 1; i <= 10; i += 1) {
  await begin.execute({ id: 'sim-r-' + i, level: '普通', direction: '方药', case_summary: '男 45 岁，胃脘痞满' }, { agent: { id: doctor } })
  await finish.execute({ id: 'sim-r-' + i, verdict: '过关' }, { agent: { id: doctor } })
}
// 事件链把「判卷工具结果」送到开关：开局→交卷→tool/call→tool/result，开关据此标记待摆打赏。
const sess = (id) => ({ id, header: {}, snapshotEvents: () => [] })
const userMsg = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
first.emit('session/event', sess(doctor), { type: 'turn/start', data: { turn: 1 } })
first.emit('session/event', sess(doctor), userMsg('【模拟问诊 · 开局】普通｜方药｜20261123-10'))
first.emit('session/event', sess(doctor), userMsg('交卷'))
first.emit('session/event', sess(doctor), { type: 'tool/call', data: { callId: 'c-fin', name: 'xueli_finish_round' } })
first.emit('session/event', sess(doctor), { type: 'tool/result', data: { message: { toolCallId: 'c-fin', content: [{ type: 'text', text: '已记下' }] } } })
// 点评那一份回答：出口应在末尾摆一次打赏，报出判完的局数。
const giftOut = await collect({ sessionId: doctor, system: TCM_SYSTEM }, [
  { type: 'text-delta', index: 0, text: '点评：辨证准确，方证对应。' },
  { type: 'finish' },
])
const giftText = giftOut.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.ok(giftText.includes('请作者喝杯茶'), '满十局点评末尾应摆打赏')
assert.ok(giftText.includes('判完 10 局'), '打赏应报出判完的局数')
// 认领一次就清：同一会话下一轮不再摆。
const againText = (await collect({ sessionId: doctor, system: TCM_SYSTEM }, [
  { type: 'text-delta', index: 0, text: '继续聊。' },
  { type: 'finish' },
])).filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
assert.ok(!againText.includes('请作者喝杯茶'), '打赏认领一次就清，下一轮不再摆')

// ── 检查 5：闭麦轮 block-end 全文清空（fix16）──
const muteSid = 'session-doctor-mute'
first.emit('session/event', sess(muteSid), { type: 'turn/start', data: { turn: 1 } })
first.emit('session/event', sess(muteSid), userMsg('【模拟问诊 · 开局】普通｜方药｜20261123-11'))
const muteOut = await collect({ sessionId: muteSid, system: TCM_SYSTEM }, [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '底牌推理：本局锚点是少阳……' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '底牌推理：本局锚点是少阳……（全文）' } },
  { type: 'block-start', index: 1, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 1, text: '底牌思考' },
  { type: 'block-end', index: 1, block: { type: 'reasoning', text: '底牌思考（全文）' } },
  { type: 'finish' },
])
for (const c of muteOut) {
  if ((c.type === 'text-delta' || c.type === 'reasoning-delta') && (c.index === 0 || c.index === 1)) {
    assert.equal(c.text, '', '闭麦轮增量文字必须清空')
  }
  if (c.type === 'block-end' && (c.index === 0 || c.index === 1)) {
    assert.equal(c.block.text, '', '闭麦轮 block-end 全文必须清空（宿主按它整块替换）')
  }
}
assert.ok(!JSON.stringify(muteOut).includes('底牌'), '闭麦轮底牌文字一个字节都不许漏出')
const muteEnds = muteOut.filter((c) => c.type === 'block-end' && (c.index === 0 || c.index === 1))
assert.equal(muteEnds.length, 2, '闭麦只清文字，块照开照收一个不丢')

// ── 检查 6：启动后建索引、补书 ──
await new Promise((r) => setTimeout(r, 6500))
assert.ok(fs.existsSync(path.join(kbDir, '索引.md')), '资料库应生成 索引.md')
assert.ok(fs.existsSync(path.join(kbDir, 'text', '03-伤寒论.md')), '应补入随包经典')
assert.equal(fs.existsSync(path.join(kbDir, 'skills')), false, '不应再复制检索规程')
assert.equal(fs.existsSync(path.join(kbDir, 'references')), false, '不应再复制剂量速查')
for (const name of ['经典', '经典注解', '名著', '医案', '方药']) {
  assert.ok(fs.statSync(path.join(kbDir, name)).isDirectory(), `应建好 ${name}/ 文件夹`)
}

// ── 检查 7：后加载的实例共用同一目录的监视，先加载的释放后也不影响后加载的 ──
const second = makeCtx()
mod.apply(second.ctx, settings)
await new Promise((r) => setTimeout(r, 3200))
// 触发一次目录变化，验证监视仍活着（不报错、索引照常）
fs.writeFileSync(path.join(kbDir, 'text', '临时探针.md'), '探针', 'utf8')
await new Promise((r) => setTimeout(r, 2500))
fs.rmSync(path.join(kbDir, 'text', '临时探针.md'), { force: true })

const warns = [...first.logs, ...second.logs].filter((l) => l[0] === 'warn')
// 遮数是正常告知（每遮一处记一条），不算异常；其余告警一条都不该有。
const unexpected = warns.filter(([, text]) => !text.includes('已把数值遮成 *'))
assert.equal(unexpected.length, 0, `不应有异常告警：${unexpected.map((w) => w[1]).join(' ;; ')}`)

// ── 收尾 ──
fs.rmSync(kbDir, { recursive: true, force: true })
fs.rmSync(homeDir, { recursive: true, force: true })
if (prevHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = prevHome
console.log('模拟通过：提示词变量、常驻口径、出口遮数、工具注册（含 disposed 抛错）、打赏全链路、闭麦 block-end、目录监视、索引生成都按预期工作。')
console.log(`日志 ${first.logs.length + second.logs.length} 条，遮数告警 ${warns.length - unexpected.length} 条，异常告警 ${unexpected.length} 条`)
process.exit(0)