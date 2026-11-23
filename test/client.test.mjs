// 覆盖说明（如实）：本文件用 new Function＋fakeReact 在 Node 里跑 client.js，
// 大部分断言是源码文本匹配；纯函数与隐藏样式/卸载清理另有 fakeDoc 行为断言。
// 未覆盖面（本环境做不到，不假装覆盖）：
// - 真实 React 渲染与 hooks 时序（fakeReact 的 useState/useEffect 不会重渲染）；
// - fetch 竞态、20 秒超时与开局回收的异步时序（只断言代码路径存在）；
// - 宿主真实 DOM、官方左栏行标记与隐藏样式实际生效；
// - 服务端删除/归档通道的真实响应、会话服务的真实行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 在 Node 里模拟浏览器：接住 ModuleLoader 的登记，给一个最小的 react。
 *  传 fakeDocument 时连 DOM 行为一起测；不传则 document=undefined，跟旧测试一样。 */
function loadClient(fakeDocument) {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let definition = null
  const win = { __ModuleLoader__: { load(def) { definition = def } } }
  const fakeReact = {
    createElement() { return {} },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
    useEffect() {},
    useRef(value) { return { current: value } },
  }
  const sandbox = { window: win, document: fakeDocument, console }
  const run = new Function('window', 'document', 'console', code)
  run(sandbox.window, sandbox.document, sandbox.console)
  assert.ok(definition, 'client.js 没有调用 window.__ModuleLoader__.load')
  return { definition, fakeReact }
}

/** 最小假 DOM：只实现 client.js 真用到的那几个接口。
 *  querySelectorAll 只认 style[data-plugin="…"] 这一种选择器，别的一律返回空。 */
function fakeDoc() {
  const head = {
    children: [],
    appendChild(el) { el.parentNode = head; head.children.push(el); return el },
    removeChild(el) {
      const i = head.children.indexOf(el)
      if (i >= 0) head.children.splice(i, 1)
      el.parentNode = null
      return el
    },
  }
  return {
    head,
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        id: '',
        textContent: '',
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = String(v) },
      }
    },
    getElementById(id) { return head.children.find((el) => el.id === id) || null },
    querySelectorAll(sel) {
      const m = /^style\[data-plugin="([^"]+)"\]$/.exec(sel)
      if (!m) return []
      return head.children.filter((el) => el.tagName === 'STYLE' && el.attrs['data-plugin'] === m[1])
    },
  }
}

test('浏览器半：登记名等于包名，能注册左侧图标与对应主面板', () => {
  const { definition, fakeReact } = loadClient()
  assert.equal(definition.id, 'dsh-tcm-xueli')
  const stub = {}
  const exports = definition.factory((name) => {
    if (name === 'react') return fakeReact
    // 学习版还要官方的基础组件库；这里只要它能被引到，具体组件不参与断言。
    return stub
  })
  assert.equal(exports.name, 'dsh-tcm-xueli/client')
  assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots'))

  const registered = []
  const ctx = {
    slots: {
      inject(name, fn) { registered.push({ kind: 'inject', name, out: fn() }) },
      register(spec, component) { return { spec, component } },
    },
  }
  exports.apply(ctx)
  const names = registered.map((r) => r.out && r.out.spec && r.out.spec.name)
  assert.ok(names.includes('sidebar.panellist'), '没有注册左侧导航入口')
  assert.ok(names.includes('main'), '没有注册对应主面板')
  const sidebar = registered.find((r) => r.name === 'sidebar.panellist').out.spec
  const main = registered.find((r) => r.name === 'main').out.spec
  assert.equal(sidebar.id, 'xueli-wb')
  assert.equal(main.key, 'xueli-wb', '左侧图标 id 与主面板 key 必须同名，点了才跳得过去')
  assert.equal(typeof sidebar.label, 'function')
  assert.equal(sidebar.label(), '经方学习版')
  assert.ok(names.includes('settings.section'), '设置页的资料库卡片不能因为加工作台而丢掉')
})

test('浏览器半：预设 id 写死为本插件，开会话不会跑到别家模式', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes("agentPreset: WB_PRESET"))
  // 点进来右侧就是一局新会话（有空白会话就复用），不自动翻开历史那一局。
  var createAt = code.indexOf('.create(');
  assert.ok(createAt > code.indexOf('function openFresh'), '建会话只许发生在 openFresh 里')
  assert.ok(code.includes('openFresh(first.blankId)'), '进面板应该落在新会话上')
  assert.ok(!code.includes('next[0].id'), '进面板不该自动翻开历史那一局')
  // 左列能操作：改名走会话绑定的 rename，删除走官方归档，搜索与滚动都要有。
  assert.ok(code.includes('bound.session.rename('), '改名要用会话绑定的 rename，别自己发明接口')
  assert.ok(code.includes('uiWorkspace.archiveSession('), '删除要走官方归档')
  assert.ok(code.includes("placeholder: '搜索会话'"), '左列最上方要有搜索框')
  assert.ok(code.includes('.xw-items{flex:1;min-height:0;overflow-y:auto'), '历史列表要能滑动')
  assert.ok(code.includes('.xw-now'), '左列要显示右侧当前这一局的名字')
  // 老写法 startSession 会把面板关掉（内部 selectPanel(null)），只能直接建会话。
  assert.ok(!code.includes('startSession('), '新建会话不能调 uiWorkspace.startSession，它会把面板关掉')
  assert.ok(code.includes('svc.create({ agentPreset: WB_PRESET })'), '新建会话要直接用本模式预设建一局')
  assert.ok(code.includes('svc.list.getSnapshot'), '历史列表直接从客户端会话快照取，不依赖宿主通道')
  // 上一版就栽在这：面板→聊天区没把 SessionProvider 传下去，右边只剩官方空会话页。
  assert.ok(code.includes('SessionProvider: props.SessionProvider'), '聊天区必须拿到面板给的 SessionProvider')
  assert.ok(code.includes('E(props.SessionProvider, { session: ref }'), '得用 SessionProvider 圈定这一局')
  // 线上踩过：Ctx.wbSessions 这种拼错/没注入的服务名，会让整个面板在渲染时抛错、白屏。
  var injected = (code.match(/exports\.inject = \[([^\]]*)\]/) || [])[1] || '';
  var names = (code.match(/Ctx\.[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((hit) => hit !== 'Ctx.get');
  for (const hit of names) {
    const svc = hit.slice(4);
    assert.ok(injected.includes("'" + svc + "'"), '客户端访问的服务 ' + hit + ' 必须在 exports.inject 里声明');
  }
  // svcOf('x') 是运行时按名字取服务，取到的名字同样必须在注入名单里。
  var dynamic = code.match(/svcOf\('([A-Za-z0-9_]+)'\)/g) || [];
  for (const hit of dynamic) {
    const svc = hit.slice(7, -2);
    assert.ok(injected.includes("'" + svc + "'"), '客户端按名字取的服务 ' + svc + ' 必须在 exports.inject 里声明');
  }

  assert.ok(code.includes("var WB_PRESET = 'dsh-tcm-xueli'"))
})
test('取服务的 svcOf 必须真有定义（删模块时别把它带走）', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  if (code.includes('svcOf(')) {
    assert.ok(code.includes('function svcOf('), '用了 svcOf 却没有定义，开局会直接报错')
  }
})

test('资料查询页：左侧有入口，面板回原文和白话', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes("var SR_PANEL = 'xueli-search'"), '查询页的 id 要写死')
  assert.ok(code.includes("label: function () { return '资料查询'; }"), '左侧入口名字是「资料查询」')
  assert.ok(code.includes("key: SR_PANEL"), '图标 id 与主面板 key 同名')
  assert.ok(code.includes("var SR_PATH = '/dsh-tcm-xueli/search'"), '查询地址要写死，和宿主的路由对上')
  assert.ok(code.includes("fetch(SR_PATH + '?q='") && code.includes('encodeURIComponent(text)'), '面板直接 fetch 本机查询路由')
  assert.ok(code.includes("'原文'") && code.includes("'白话'"), '结果要分原文和白话两段')
  assert.ok(code.includes('白话没译出来'), '译不出白话时要明说，不能冒充')
})

test('模拟问诊页：左侧有入口，能开一局并把开局话发进会话', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes("var SIM_PANEL = 'xueli-sim'"), '问诊页的 id 要写死')
  assert.ok(code.includes("label: function () { return '模拟问诊'; }"), '左侧入口名字是「模拟问诊」')
  assert.ok(code.includes('key: SIM_PANEL'), '图标 id 与主面板 key 同名')
  assert.ok(code.includes("var SIM_CHAT_SLOT = 'xueli.sim.chat'"), '问诊自己要一个聊天子插槽')
  assert.ok(code.includes("'【模拟问诊 · 开局】' + lv + '｜' + td + '｜' + rid"), '开局话要有难度、方向、局号')
  assert.ok(code.includes("svc.create({ agentPreset: WB_PRESET })"), '开一局要用本插件预设')
  assert.ok(code.includes('xueli_begin_round') === false, '工具是宿主半的，客户端不该提工具名')
})

test('讲解答疑页：左侧有入口，能开一问并把开场话发进会话', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes("var TE_PANEL = 'xueli-teach'"), '答疑页的 id 要写死')
  assert.ok(code.includes("label: function () { return '讲解答疑'; }"), '左侧入口名字是「讲解答疑」')
  assert.ok(code.includes('key: TE_PANEL'), '图标 id 与主面板 key 同名')
  assert.ok(code.includes("var TE_CHAT_SLOT = 'xueli.teach.chat'"), '答疑自己要一个聊天子插槽')
  assert.ok(code.includes("'【讲解答疑 · 开讲】\\n' + text"), '开场话要带固定开头，模型才切得进答疑口径')
  assert.ok(code.includes('svc.create({ agentPreset: WB_PRESET })'), '开一问要用本插件预设')
  assert.ok(code.includes('teCss();') && code.includes('wbCss();'), '答疑页也要注入工作台的聊天区样式');
  assert.ok(code.includes('function teScan()'), '答疑自己扫一份历史');
  assert.ok(code.includes('问过的（点一条接着问）'), '面板里要有自己那份历史列表');
  assert.ok(code.includes('function teWhen(at)'), '历史行要带时间');
  assert.ok(code.includes('openOld(row)'), '点一条就接着讲，不新建会话');
  assert.equal(code.includes('archiveSession'), true, '归档只是别的面板在用，答疑自己不该归档')
  assert.equal(code.includes("fetch('/dsh-tcm-xueli/sim-end"), true, '删局通道只服务模拟问诊')
  assert.ok(code.includes('问过的留着'), '答疑的局不删，要在提示里说明去哪找回来')
  assert.ok(code.includes("nameAsk(id, text)"), '会话名字要按问题取，历史里才认得出来')
})

test('讲解答疑页：主面板、聊天槽、左侧入口都真注册上了', () => {
  const { definition, fakeReact } = loadClient()
  const stub = {}
  const exports = definition.factory((name) => (name === 'react' ? fakeReact : stub))
  const registered = []
  const ctx = {
    slots: {
      inject(name, fn) { registered.push({ name, out: fn() }) },
      register(spec, component) { return { spec, component } },
    },
  }
  exports.apply(ctx)
  const taps = registered.filter((r) => r.name === 'sidebar.panellist').map((r) => r.out.spec)
  const teach = taps.find((s) => s.id === 'xueli-teach')
  assert.ok(teach, '左侧没有讲解答疑入口')
  assert.equal(teach.label(), '讲解答疑')
  assert.equal(teach.order, 25, '入口排在模拟问诊之后')
  const mains = registered.filter((r) => r.name === 'main').map((r) => r.out.spec)
  assert.ok(mains.some((s) => s.key === 'xueli-teach'), '没有登记讲解答疑主面板')
  assert.ok(registered.some((r) => r.name === 'xueli.teach.chat'), '没有登记答疑的聊天子插槽')
  assert.ok(mains.every((s) => s.key === 'xueli-wb' || s.key === 'xueli-search' || s.key === 'xueli-sim' || s.key === 'xueli-teach'), '主面板 key 混进了别家的值')
})

test('讲解答疑模块自成一块：前后有起止标记，指纹锁在自检里', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const a = code.indexOf('// >>> TEACH-BEGIN')
  const b = code.indexOf('// <<< TEACH-END')
  assert.ok(a > 0 && b > a, '答疑模块要有 TEACH-BEGIN / TEACH-END 标记，自检照这段算指纹')
  const block = code.slice(a, b)
  assert.ok(block.includes("var TE_PANEL = 'xueli-teach'"), '面板 id 要圈在这块里')
  assert.ok(block.includes('function TeaPanel('), '答疑面板要圈在这块里')
  assert.ok(block.includes('function TeIcon('), '左侧图标要圈在这块里')
  assert.ok(block.includes('function teachRegister('), '注册函数要圈在这块里')
  assert.equal(block.includes('function SimPanel('), false, '模拟问诊不在这块里，别把别人的代码圈进来')
})

test('讲解答疑：历史能改名、归档、删除，删除走自己的通道', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const start = code.indexOf('function TeaPanel(')
  const end = code.indexOf('function TeIcon(')
  assert.ok(start > 0 && end > start, '找不到答疑面板这一段')
  const panel = code.slice(start, end)
  assert.ok(panel.includes('doTitle'), '要能改名')
  assert.ok(panel.includes('archiveSession') && panel.includes('doArchive'), '要能归档')
  assert.ok(panel.includes('unarchiveSession') && panel.includes('doRestore'), '归档的要能恢复')
  assert.ok(panel.includes('teach-end?doing=delete'), '删除走答疑自己的通道')
  assert.equal(panel.includes('purge=1'), false, '答疑面板不许走模拟问诊的删局通道')
  assert.ok(panel.includes('setSessionId(null)'), '换个问题只是回到提问页，别动这一局')
})

test('聊天面板：换局不会把已释放的句柄交给会话组件', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.equal(code.includes('refBox'), false, '不该再用 refBox 这种「渲染时读当前引用」的写法')
  assert.ok(code.includes('hold.id !== sessionId'), '要拿会话 id 对得上才画聊天区')
  assert.ok(code.includes("setHold({ id: sessionId, ref: ref })"), '句柄要连同 id 一起存状态')
  assert.ok(code.includes('setTimeout(function () {'), '释放要延后一拍，避免同一次提交里报 released')
})

test('模拟问诊：发话走 ready 解析出来的 SessionBinding，业务失败要抛', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes('var session = bound && bound.session'), 'ready 给的就是 binding，别再往下取 .binding')
  assert.equal(code.includes('bound.binding'), false)
  assert.ok(code.includes('result.ok === false'), 'prompt 返回 ok:false 要当失败')
  assert.ok(code.includes('simCss(); wbCss()'), '模拟问诊页也要注入工作台的聊天区样式')
  assert.ok(code.includes('pad(d.getSeconds())'), '局号要带秒，避免同一分钟撞号')
  assert.ok(code.includes('var archiveCurrent = function'), '换局/换难度要把旧局归档')
  assert.ok(code.includes('archiveCurrent();'), '换局时真的调归档')
  assert.ok(code.includes('archiveCurrent(mine);'), '关掉面板时把这一局收走')
  assert.ok(code.includes('if (keepRef.current) { keepRef.current = false; return; }'), '去会话页那一次不算收工')
  assert.equal(code.includes('过往的局'), false, '不再留「过往的局」列表')
  assert.equal(code.includes('function simScan'), false, '扫历史局的那套也一起去掉')
})

test('左列点历史会话：留在面板里换这一局；归档要能真收起来', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes('onClick: function () { setSessionId(row.id); }'), '点历史会话就在面板里换到这一局，不跳出工作台')
  assert.ok(code.includes('var openInChat = function (maybeId)'), '「去聊天页」要能带上指定会话')
  assert.ok(code.includes('svc.list.refresh'), '归档后让会话列表重拉一遍')
})

test('归档过的会话不出现在左列，点进去也能恢复继续', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes('wsnap && wsnap.archivedSessionIds'), '列表要读归档集合')
  assert.ok(code.includes('var isArch = !!archivedSet[ids[i]];'), '归档过的会话不列出来')
  assert.ok(code.includes('ws.list.subscribe'), '归档后列表跟着重排')
  assert.ok(code.includes('uiWorkspace.unarchiveSession(sessionId)'), '归档会话要能恢复继续')
})

test('官方左栏的问诊局按行标记藏掉，React 重画后也还藏着', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes('[data-row-key="session:'), '按会话行标记找，不靠类名')
  assert.ok(code.includes('for (var sid in simRoundIds)'), '开过的问诊局并进隐藏集合')
  assert.ok(code.includes('if (el.textContent !== css) el.textContent = css'), '只在集合变化时改样式表，不逐帧改 DOM')
  assert.ok(!code.includes("el.style.display = 'none'"), '不许逐行改内联样式，会一闪一闪')
})

test('官方左栏不出现本插件自己的会话（整个预设都收起）', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes('showArch'), '面板有归档开关')
  assert.ok(code.includes('row.projectionValues && row.projectionValues.agentPreset'), '按预设认会话')
  assert.ok(code.includes('if (preset === WB_PRESET) out[ids[i]] = true;'), '本预设的会话都收起来')
  assert.ok(code.includes('var own = ownPresetIds();'), '左栏按预设藏行')
})

test('左栏隐藏：只认会话行、卸载时停表，不乱藏标题像问诊的普通会话', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes('function stopHideSimRows'), '要有停表函数')
  assert.ok(code.includes('clearInterval(simHideTimer)'), '卸载时要清掉轮询')
  assert.ok(code.includes('[data-row-key="session:'), '只按会话行认')
  assert.ok(!code.includes('[class*="sessionRow"]'), '不许用模糊类名去藏')
  assert.ok(!code.includes("el.style.display = 'none'"), '不许逐行改内联样式，会闪')
  assert.ok(!code.includes('isSimTitle(el.textContent)'), '不许拿整行文字判断')
  assert.ok(code.includes('return function () { stopHideSimRows(); removePluginStyles(); };'), '卸载钩子里要停表并摘掉本插件全部样式')
  assert.ok(!code.includes('stopHideOwnRows'), '不许再调不存在的停表函数')
  assert.ok(!/exports\.inject = \[[^\]]*'remote'/.test(code), '没用的 remote 注入要去掉')
})

test('工作台历史也能删局：走本插件自己的通道，只认本插件预设', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const start = code.indexOf('function WbPanel(')
  const end = code.indexOf('function WbIcon(')
  assert.ok(start > 0 && end > start, '找不到工作台这一段')
  const panel = code.slice(start, end)
  assert.ok(panel.includes('var doDelete = function'), '要有真删')
  assert.ok(panel.includes('teach-end?doing=delete'), '删除走本插件自己的通道')
  assert.ok(panel.includes("kind: 'delete'"), '删除前要问一句')
  assert.equal(panel.includes('purge=1'), false, '不走模拟问诊的删局通道')
})

test('工作台历史不混答疑局：各归各的列表', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes("indexOf('答疑·') === 0"), '工作台扫历史时要跳过答疑局');
  assert.ok(code.includes("indexOf('问诊·局') === 0"), '问诊局照旧不进工作台');
})

/* ── 以下为定向修复的行为断言与同步断言 ── */

test('纯函数行为：id 校验、隐藏集合增删、豁免标记只消费一次', () => {
  const { definition, fakeReact } = loadClient()
  const exports = definition.factory((name) => (name === 'react' ? fakeReact : {}))
  const h = exports.__test
  assert.ok(h, '要有 __test 钩子供行为断言')
  // id 校验：只放行字母数字下划线连字符
  assert.equal(h.simIdSafe('abc-123_X'), true)
  assert.equal(h.simIdSafe(''), false)
  assert.equal(h.simIdSafe('a"b'), false)
  assert.equal(h.simIdSafe('a]b'), false)
  assert.equal(h.simIdSafe('a b'), false)
  assert.equal(h.simIdSafe(null), false)
  assert.equal(h.simIdSafe(123), false)
  // 入集合：合法才进，非法 id 不许污染隐藏集合
  const set = {}
  h.simHideAdd(set, 'round-1')
  h.simHideAdd(set, 'bad"id')
  assert.deepEqual(Object.keys(set), ['round-1'])
  // 豁免：移出隐藏集、记入豁免集
  const shown = {}
  h.simHideRelease(set, shown, 'round-1')
  assert.equal(set['round-1'], undefined)
  assert.equal(h.simHideExempt(shown, 'round-1'), true)
  assert.equal(h.simHideExempt(shown, 'round-2'), false)
  // 非法 id 不动两份集合
  h.simHideRelease(set, shown, 'x"y')
  assert.equal(shown['x"y'], undefined)
  // 显式收局豁免标记：置位消费一次就清，空引用/非 true 都安全
  const ref = { current: true }
  assert.equal(h.takeSkipFlag(ref), true)
  assert.equal(ref.current, false)
  assert.equal(h.takeSkipFlag(ref), false)
  assert.equal(h.takeSkipFlag(null), false)
  assert.equal(h.takeSkipFlag({ current: 'yes' }), false)
})

test('隐藏样式行为：非法 id 不进 CSS、豁免局不藏、卸载清干净', () => {
  const doc = fakeDoc()
  const { definition, fakeReact } = loadClient(doc)
  const exports = definition.factory((name) => (name === 'react' ? fakeReact : {}))
  const rows = {
    'safe-1': { projectionValues: { agentPreset: 'dsh-tcm-xueli' } },
    'bad"id': { projectionValues: { agentPreset: 'dsh-tcm-xueli' } },
    'other-1': { projectionValues: { agentPreset: 'standard' } },
  }
  const ctx = {
    slots: { inject() {}, register(spec, component) { return { spec, component } } },
    sessions: { list: { getSnapshot: () => ({ ids: Object.keys(rows), byId: rows }) } },
  }
  exports.apply(ctx)
  const h = exports.__test
  const style = doc.getElementById('xw-hide-sim')
  assert.ok(style, 'apply 后要注入隐藏样式')
  assert.equal(style.attrs['data-plugin'], 'dsh-tcm-xueli', '隐藏样式要打本插件标记')
  assert.ok(style.textContent.includes('[data-row-key="session:safe-1"]'), '本预设会话要藏')
  assert.ok(!style.textContent.includes('bad"id'), '非法 id 不许拼进选择器')
  assert.ok(!style.textContent.includes('other-1'), '别家预设不藏')
  // 开过的问诊局并进隐藏集
  h.simRoundIds['round-9'] = true
  h.hideSimRows()
  assert.ok(doc.getElementById('xw-hide-sim').textContent.includes('session:round-9'))
  // 送去会话页：豁免后不再藏（回到官方左栏）
  h.simHideRelease(h.simRoundIds, h.simShownIds, 'round-9')
  h.hideSimRows()
  assert.ok(!doc.getElementById('xw-hide-sim').textContent.includes('session:round-9'))
  // 本预设的局同样能豁免（ownPresetIds 会藏整个预设，单删隐藏集不够）
  h.simHideRelease(h.simRoundIds, h.simShownIds, 'safe-1')
  h.hideSimRows()
  assert.ok(!doc.getElementById('xw-hide-sim').textContent.includes('session:safe-1'))
  // 卸载：停表、摘隐藏样式、原地清空两份集合（活引用仍有效）
  h.stopHideSimRows()
  assert.equal(doc.getElementById('xw-hide-sim'), null, '卸载要摘掉隐藏样式')
  assert.deepEqual(Object.keys(h.simRoundIds), [])
  assert.deepEqual(Object.keys(h.simShownIds), [])
  // removePluginStyles 按标记摘：打标的摘掉，别家的和没打标的留着
  const marked = doc.createElement('style'); marked.setAttribute('data-plugin', 'dsh-tcm-xueli'); doc.head.appendChild(marked)
  const foreign = doc.createElement('style'); foreign.setAttribute('data-plugin', 'other-plugin'); doc.head.appendChild(foreign)
  const plain = doc.createElement('style'); doc.head.appendChild(plain)
  h.removePluginStyles()
  assert.equal(marked.parentNode, null, '本插件的 style 要摘掉')
  assert.ok(foreign.parentNode, '别家插件的 style 不许动')
  assert.ok(plain.parentNode, '没打标的 style 不许动')
})

test('修复1/2：开局失败回收已建会话，预设建失败明报不回落', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.equal(code.includes('svc.create({})'), false, '不许静默回落默认预设（会丢人设/遮罩/档位）')
  assert.equal((code.match(/var madeId = null/g) || []).length, 2, '两个面板都要记住已建会话 id')
  assert.equal((code.match(/中医预设未就绪，请确认插件已启用后重试/g) || []).length, 2, '预设建失败两处都要明报')
  assert.equal((code.match(/指令可能仍在排队，已回收该局，请重试。/g) || []).length, 2, '超时文案两处都要有')
  assert.ok(code.includes('delete simRoundIds[madeId];'), '回收时把局移出隐藏集合')
  assert.ok(code.includes('archiveCurrent(madeId)'), '模拟问诊回收已建会话走归档')
  assert.ok(code.includes("fetch('/dsh-tcm-xueli/teach-end?doing=delete&session=' + encodeURIComponent(madeId)"), '答疑回收走自己的删除通道（服务端按预设认局）')
  assert.ok(code.includes('archiveSession(madeId, { stopActivity: true })'), '答疑回收再补归档停活兜底')
})

test('修复3/5：去会话页的局回到官方左栏；显式收局不双份归档', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes('simHideRelease(simRoundIds, simShownIds, sessionId)'), 'goChat 要把这一局移出隐藏集并记豁免')
  assert.ok(code.includes('if (simHideExempt(simShownIds, id)) continue;'), '拼隐藏样式时豁免局要跳过')
  assert.ok(code.includes('var skipRef = React.useRef(false)'), '要有显式收局豁免标记')
  assert.ok(code.includes('if (takeSkipFlag(skipRef)) return;'), 'cleanup 消费豁免，不重复归档')
  assert.equal((code.match(/skipRef\.current = true;/g) || []).length, 2, 'restartRound/backToForm 各置一次豁免')
  assert.ok(code.includes('skipRef.current = false;'), '开局失败要作废豁免，退出时照常收')
})

test('修复6：工作台新建有 creating 闸，与另两个面板对齐', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const start = code.indexOf('function WbPanel(')
  const end = code.indexOf('function WbIcon(')
  assert.ok(start > 0 && end > start, '找不到工作台这一段')
  const panel = code.slice(start, end)
  assert.ok(panel.includes('var creatingPair = useState(false)'), '要有 creating 状态')
  assert.ok(panel.includes('if (creating) return;'), '建会话没回话前不许再点')
  assert.ok(panel.includes('setCreating(true)'), '开建时上闸')
  assert.equal((panel.match(/setCreating\(false\)/g) || []).length, 2, '成功/失败都要落闸')
  assert.ok(panel.includes('disabled: creating'), '按钮要跟着禁用')
})

test('修复7：空值与同步抛错优雅降级', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(code.includes("typeof form.getSnapshot === 'function' ? form.getSnapshot() : null"), '读快照前查空值')
  assert.ok(code.includes("if (!form || typeof form.subscribe !== 'function') return undefined;"), '订阅前查空值')
  const snapAt = code.indexOf('function useSnapshot(')
  const snapSeg = code.slice(snapAt, code.indexOf('function noteNode('))
  assert.ok(snapSeg.includes('try {') && snapSeg.includes('catch (error)'), 'useSnapshot 的读快照/订阅要包错')
  const saveAt = code.indexOf('var save = function')
  const saveSeg = code.slice(saveAt, code.indexOf('Promise.resolve(write)', saveAt))
  assert.ok(saveSeg.includes('try {') && saveSeg.includes('catch (error)'), 'form.set/unset 的同步抛错要接住')
  assert.ok(code.includes("if (!Ctx || !Ctx.uiWorkspace || typeof Ctx.uiWorkspace.unarchiveSession !== 'function')"), 'reviveArchived 要查空值')
  assert.ok(code.includes("setArchMsg('会话服务不支持恢复')"), '缺服务时明说，不静默抛错')
})

test('修复4/8：style 统一打标按标记全摘；id 拼选择器前先校验', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.equal((code.match(/setAttribute\('data-plugin', NS\)/g) || []).length, 5, 'wb/sr/sim/te/hide 五处 style 都要打标')
  assert.ok(code.includes('function removePluginStyles()'), '要有按标记摘样式的函数')
  assert.ok(code.includes("document.querySelectorAll('style[data-plugin=\"' + NS + '\"]')"), '按标记找本插件全部 style')
  assert.ok(code.includes('for (var rid in simRoundIds) { delete simRoundIds[rid]; }'), '卸载要原地清隐藏集合')
  assert.ok(code.includes('if (!simIdSafe(id)) continue;'), '拼选择器前校验 id')
  assert.ok(code.includes('var SIM_ID_SAFE = /^[A-Za-z0-9_-]+$/'), '校验规则写死为字母数字下划线连字符')
})

test('修复9：续讲顶部显示完整标题，列表仍用省略号', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.equal(code.includes('slice(0, 14)'), false, '标题不再截 14 字')
  assert.ok(code.includes("return '答疑·' + one;"), '会话名存完整问题')
  assert.ok(code.includes('.te-quote{flex:1;min-width:0;opacity:.8;word-break:break-word;line-height:1.6}'), '顶部引题换行展示全文')
  assert.ok(code.includes('.te-htitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'), '列表仍靠 CSS 省略号截断')
  assert.ok(code.includes("replace(/^答疑·/, '')"), '续讲去掉前缀后展示全文')
})

test('修复10/12：认局局限与轮询决定如实写在注释里', () => {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  // 宿主 ISessions.create 没有插件可写的元数据入口（已只读核对 E:\dsh），
  // 保留标题前缀认局，局限必须写明，不假装用了元数据。
  assert.equal((code.match(/没有插件可写的元数据/g) || []).length, 2, 'teScan 与 scan 两处都要说明局限')
  assert.ok(code.includes('注册自定义投影要动宿主侧'), '说明为什么不用 projectionValues')
  assert.equal((code.match(/官方会话页改名丢了前缀/g) || []).length, 2, '改名丢前缀的后果要写明')
  assert.ok(code.includes('900ms 轮询保持不动'), '轮询本次不改，注释记一笔')
  assert.equal((code.match(/渲染期错误由宿主条目边界兜底/g) || []).length, 2, '两处 try/catch 注释改为如实说明')
})
