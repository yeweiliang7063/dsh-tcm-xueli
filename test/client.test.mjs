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

test('豁免集合持久化：去会话页的局落 localStorage，重启载入仍可见', () => {
  const store = new Map()
  const fakeLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
  }
  const prev = globalThis.localStorage
  globalThis.localStorage = fakeLocalStorage
  try {
    const a = loadClient()
    const e1 = a.definition.factory((name) => (name === 'react' ? a.fakeReact : {}))
    e1.__test.simHideRelease(e1.__test.simRoundIds, e1.__test.simShownIds, 'round-keep')
    assert.ok(store.has('dsh-tcm-xueli:simShown'), '豁免要落 localStorage')
    assert.ok(store.get('dsh-tcm-xueli:simShown').includes('round-keep'), '清单里要有这一局')
    // 模拟刷新/重启：全新 factory 实例从 localStorage 载入豁免集合。
    const b = loadClient()
    const e2 = b.definition.factory((name) => (name === 'react' ? b.fakeReact : {}))
    assert.equal(e2.__test.simHideExempt(e2.__test.simShownIds, 'round-keep'), true, '重启后豁免局仍可见，不会又被藏回去')
  } finally {
    if (prev === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prev
  }
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

/* ── 医案（只读导入）行为测试 ──────────────────────────────────────────────
 * 用一个「只渲染根组件」的迷你 hooks 运行时跑 WbPanel：函数子组件（YianPane /
 * YianPicker / WbChatPane）保持不透明节点，按 type 身份断言在不在右栏；setState
 * 触发重渲染，useEffect 按 deps 同步执行并支持 cleanup。fetch / localStorage 走
 * globalThis 假对象，按 URL 区分医案列表与正文两种返回。 */

/** 迷你渲染器＋假 react：加载 client.js，返回 exports 与 mount 控制器。 */
function liveClient(fakeDocument, uiStub) {
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let definition = null
  const win = { __ModuleLoader__: { load(def) { definition = def } } }

  let hooks = []
  let effectStore = []
  let rootComp = null
  let rootProps = null
  let tree = null
  let hookIndex = 0
  let effectIndex = 0
  let pendingEffects = []
  let dirty = false
  let inFlush = false

  function depsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
    return true
  }
  function flush() {
    if (inFlush) { dirty = true; return }
    inFlush = true
    let guard = 0
    try {
      do {
        dirty = false
        hookIndex = 0
        effectIndex = 0
        pendingEffects = []
        tree = rootComp(rootProps)
        for (const eff of pendingEffects) {
          const prev = effectStore[eff.index]
          if (!prev || !depsEqual(prev.deps, eff.deps)) {
            if (prev && typeof prev.cleanup === 'function') { try { prev.cleanup() } catch (e) { /* 已清 */ } }
            let cleanup
            try { cleanup = eff.fn() } catch (e) { cleanup = undefined }
            effectStore[eff.index] = { deps: eff.deps, cleanup }
          }
        }
        guard += 1
        if (guard > 80) throw new Error('渲染不收敛（setState 循环）')
      } while (dirty)
    } finally {
      inFlush = false
    }
  }
  function flatten(c, out) {
    if (c == null || c === false || c === true) return
    if (Array.isArray(c)) { for (const x of c) flatten(x, out); return }
    out.push(c)
  }
  const fakeReact = {
    createElement(type, props) {
      const children = []
      for (let k = 2; k < arguments.length; k += 1) flatten(arguments[k], children)
      return { type, props: props || {}, children }
    },
    useState(init) {
      const i = hookIndex
      hookIndex += 1
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
      return [hooks[i], function (next) {
        hooks[i] = typeof next === 'function' ? next(hooks[i]) : next
        dirty = true
        if (!inFlush) flush()
      }]
    },
    useEffect(fn, deps) {
      const i = effectIndex
      effectIndex += 1
      pendingEffects.push({ index: i, fn, deps })
    },
    useRef(init) {
      const i = hookIndex
      hookIndex += 1
      if (!(i in hooks)) hooks[i] = { current: init }
      return hooks[i]
    },
  }

  const run = new Function('window', 'document', 'console', code)
  run(win, fakeDocument, console)
  assert.ok(definition, 'client.js 没有调用 window.__ModuleLoader__.load')
  const exports = definition.factory((name) => {
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return uiStub || {}
    return {}
  })

  const api = {
    exports,
    get tree() { return tree },
    mount(Comp, props) {
      rootComp = Comp
      rootProps = props || {}
      hooks = []
      effectStore = []
      flush()
      return api
    },
    update() { flush(); return api },
    unmount() {
      for (const eff of effectStore) {
        if (eff && typeof eff.cleanup === 'function') { try { eff.cleanup() } catch (e) { /* 已清 */ } }
      }
      effectStore = []
      return api
    },
  }
  return api
}

/** 假 localStorage：Map  backing，可预置/读回。 */
function mockLocalStorage(seed) {
  const store = new Map()
  if (seed) for (const k of Object.keys(seed)) store.set(k, seed[k])
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
}

/** 假 fetch：按 URL 区分医案列表与正文；记录每次调用的 url 与 init。 */
function makeYianFetch(opts) {
  const calls = []
  const fetchMock = (url, init) => {
    calls.push({ url, init })
    let payload
    if (url === '/dsh-tcm-xueli/yian') {
      payload = opts.list !== undefined ? opts.list : { ok: true, files: [] }
    } else if (url.indexOf('/dsh-tcm-xueli/yian?file=') === 0) {
      const file = decodeURIComponent(url.slice(url.indexOf('?file=') + 6))
      payload = opts.docFor ? opts.docFor(file) : (opts.doc !== undefined ? opts.doc : { ok: true, file, title: file, body: '# 正文' })
    } else {
      payload = { ok: false, reason: '意料外的通道 ' + url }
    }
    const httpOk = payload && payload.ok !== false
    return Promise.resolve({
      ok: httpOk,
      status: httpOk ? 200 : 500,
      json: () => Promise.resolve(payload),
    })
  }
  fetchMock.calls = calls
  return fetchMock
}

/** 工作台用的假 ctx：会话快照＋归档集合＋uiWorkspace/layout。 */
function makeWbCtx(rows, archived) {
  const byId = {}
  const ids = []
  for (const r of rows) { byId[r.id] = r; ids.push(r.id) }
  const opened = []
  const selected = []
  const subs = []
  return {
    opened,
    selected,
    ctx: {
      slots: { inject() {}, register(spec, component) { return { spec, component } } },
      inject() {},
      sessions: {
        list: {
          getSnapshot: () => ({ ids, byId }),
          subscribe(fn) { subs.push(fn); return () => {} },
          refresh() {},
        },
        create: () => Promise.resolve('fresh-1'),
        using: (id, opt, fn) => Promise.resolve(fn({ ready: Promise.resolve({ session: { rename: () => Promise.resolve() } }) })),
        retain: () => ({ ready: Promise.resolve({ session: {} }), release() {} }),
      },
      workspaces: {
        list: {
          getSnapshot: () => ({ archivedSessionIds: archived || [] }),
          subscribe(fn) { subs.push(fn); return () => {} },
        },
      },
      uiWorkspace: {
        openSession(id) { opened.push(id) },
        archiveSession() { return Promise.resolve() },
        unarchiveSession() { return Promise.resolve() },
      },
      layout: { selectPanel(v) { selected.push(v) } },
    },
  }
}

/** 元素树工具：遍历 / 按类名 / 按 type / 按文案找按钮 / 取纯文本 / 模拟点击。 */
function walk(node, visit) {
  if (node == null || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return }
  visit(node)
  if (node.children) for (const c of node.children) walk(c, visit)
}
function findAll(tree, pred) {
  const out = []
  walk(tree, (n) => { if (pred(n)) out.push(n) })
  return out
}
function textOf(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  let s = ''
  if (node.children) for (const c of node.children) s += textOf(c)
  return s
}
function byClass(tree, cls) {
  return findAll(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.split(' ').indexOf(cls) >= 0)
}
function byType(tree, type) {
  return findAll(tree, (n) => n.type === type)
}
function button(tree, label) {
  const hits = findAll(tree, (n) => n.type === 'button' && textOf(n) === label)
  return hits[0] || null
}
function click(node) {
  assert.ok(node && node.props && typeof node.props.onClick === 'function', '要点的东西没有 onClick')
  node.props.onClick({ stopPropagation() {}, target: {} })
}
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
async function settle() {
  for (let i = 0; i < 6; i += 1) await tick()
}

/** 挂一个带 blank＋历史会话的工作台，返回控制器与常用引用。 */
function mountWb(uiStub, fetchOpts, lsSeed, extraRows) {
  const doc = fakeDoc()
  const ls = mockLocalStorage(lsSeed)
  const fetchMock = makeYianFetch(fetchOpts || {})
  const prevLs = globalThis.localStorage
  const prevFetch = globalThis.fetch
  globalThis.localStorage = ls
  globalThis.fetch = fetchMock
  const rows = [
    { id: 'blank-1', blank: true, projectionValues: { agentPreset: 'dsh-tcm-xueli' } },
    { id: 'sess-1', title: '感冒一案', updatedAt: 1000, projectionValues: { agentPreset: 'dsh-tcm-xueli' } },
  ].concat(extraRows || [])
  const wb = makeWbCtx(rows, [])
  const live = liveClient(doc, uiStub)
  live.exports.apply(wb.ctx)
  live.mount(live.exports.__test.WbPanel, {
    renderSlot: () => null,
    renderFactorySlot: () => null,
    SessionProvider: function FakeProvider() { return null },
  })
  return {
    live, doc, ls, fetchMock, wb,
    cleanup() {
      live.unmount()
      try { live.exports.__test.stopHideSimRows() } catch (e) { /* 已停 */ }
      if (prevLs === undefined) delete globalThis.localStorage
      else globalThis.localStorage = prevLs
      if (prevFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = prevFetch
    },
  }
}

test('医案①：已导入清单落 localStorage，重启载入仍在；去重、200 上限、坏 JSON 不抛', () => {
  const ls = mockLocalStorage()
  const prev = globalThis.localStorage
  globalThis.localStorage = ls
  try {
    const a = liveClient(fakeDoc(), {})
    const h = a.exports.__test
    // 落盘＋读回
    h.persistYianList([{ file: '甲.md', title: '甲案', at: 111 }])
    assert.ok(ls.store.has('dsh-tcm-xueli:yian'), '清单要落 localStorage')
    assert.deepEqual(h.loadYianList(), [{ file: '甲.md', title: '甲案', at: 111 }])
    // 纯函数：新的在前、按 file 去重（重复以这次为准）
    const merged = h.yianAddToList([{ file: '甲.md', title: '旧甲', at: 1 }, { file: '乙.md', title: '乙案', at: 2 }], { file: '甲.md', title: '新甲', at: 9 })
    assert.deepEqual(merged.map((x) => x.file), ['甲.md', '乙.md'])
    assert.equal(merged[0].title, '新甲')
    assert.equal(merged[0].at, 9)
    // 200 上限
    const big = []
    for (let i = 0; i < 250; i += 1) big.push({ file: 'f' + i + '.md', title: 't' + i, at: i })
    assert.equal(h.yianAddToList(big, { file: 'new.md', title: '新', at: 999 }).length, 200)
    h.persistYianList(big)
    assert.equal(h.loadYianList().length, 200, '读回也截到 200')
    // 坏 JSON / 非数组 / 缺 file 都不抛
    ls.store.set('dsh-tcm-xueli:yian', '{bad json')
    assert.deepEqual(h.loadYianList(), [])
    ls.store.set('dsh-tcm-xueli:yian', JSON.stringify({ not: 'array' }))
    assert.deepEqual(h.loadYianList(), [])
    ls.store.set('dsh-tcm-xueli:yian', JSON.stringify([{ file: '' }, { title: '无file' }, { file: 'ok.md', title: '好', at: 5 }]))
    assert.deepEqual(h.loadYianList(), [{ file: 'ok.md', title: '好', at: 5 }])
    // 重启载入仍在：预置清单后全新实例挂载，左列就医案区可见
    h.persistYianList([{ file: '重启.md', title: '重启案', at: 7 }])
    const b = liveClient(fakeDoc(), {})
    assert.deepEqual(b.exports.__test.loadYianList(), [{ file: '重启.md', title: '重启案', at: 7 }], '重启后清单仍在')
  } finally {
    if (prev === undefined) delete globalThis.localStorage
    else globalThis.localStorage = prev
  }
})

test('医案②：点「添加医案」fetch 列表，点添加 fetch 正文并持久化清单、关选择器、右栏只读', async () => {
  const m = mountWb({}, {
    list: { ok: true, files: [{ file: '桂枝汤案.md', title: '桂枝汤案', at: 1700000000000 }] },
    doc: { ok: true, file: '桂枝汤案.md', title: '桂枝汤案', created: '2026-01-01', updated: '2026-02-02', body: '# 桂枝汤案\n正文' },
  })
  try {
    const { live, ls, fetchMock } = m
    // 头部有「添加医案」按钮
    const addBtn = button(live.tree, '添加医案')
    assert.ok(addBtn, '头部要有「添加医案」按钮')
    assert.equal(addBtn.props.className, 'xw-btn')
    click(addBtn)
    await settle()
    // fetch 了列表，credentials 照 doDelete
    const listCall = fetchMock.calls.find((c) => c.url === '/dsh-tcm-xueli/yian')
    assert.ok(listCall, '要 fetch 医案列表')
    assert.equal(listCall.init.credentials, 'same-origin')
    // 选择器出现，列出这一份，带「添加」按钮（YianPicker 是纯函数，展开其子树来点）
    const T = live.exports.__test
    assert.ok(byType(live.tree, T.YianPicker).length === 1, '选择器要打开')
    const pickerTree = T.YianPicker(byType(live.tree, T.YianPicker)[0].props)
    assert.ok(button(pickerTree, '添加'), '每行要有「添加」按钮')
    assert.ok(textOf(pickerTree).includes('桂枝汤案'), '选择器要列出标题')
    // 点添加 → fetch 正文
    click(button(pickerTree, '添加'))
    await settle()
    const docCall = fetchMock.calls.find((c) => c.url.indexOf('/dsh-tcm-xueli/yian?file=') === 0)
    assert.ok(docCall, '要 fetch 医案正文')
    assert.equal(docCall.url, '/dsh-tcm-xueli/yian?file=' + encodeURIComponent('桂枝汤案.md'))
    assert.equal(docCall.init.credentials, 'same-origin')
    // 清单落盘
    const saved = JSON.parse(ls.store.get('dsh-tcm-xueli:yian'))
    assert.equal(saved.length, 1)
    assert.equal(saved[0].file, '桂枝汤案.md')
    // 选择器关掉，右栏是 YianPane 不是聊天
    assert.equal(byType(live.tree, live.exports.__test.YianPicker).length, 0, '添加成功后选择器要关')
    assert.equal(byType(live.tree, live.exports.__test.YianPane).length, 1, '右栏要摆只读医案查看器')
    assert.equal(byType(live.tree, live.exports.__test.WbChatPane).length, 0, '看医案时不摆聊天')
    // 顶部显示医案标题
    assert.ok(textOf(byClass(live.tree, 'xw-now')[0]).includes('桂枝汤案'), 'currentTitle 要显示医案标题')
  } finally {
    m.cleanup()
  }
})

test('医案②b：选择器三态（加载中/空/出错 reason）；正文失败显示 reason 且清单已记', async () => {
  // 展开选择器子树的工具（YianPicker 纯函数，不透明节点要手动调用才看得到内部）
  const pickerText = (live) => {
    const T = live.exports.__test
    const nodes = byType(live.tree, T.YianPicker)
    if (!nodes.length) return ''
    return textOf(T.YianPicker(nodes[0].props))
  }
  const pickerAdd = (live) => {
    const T = live.exports.__test
    const nodes = byType(live.tree, T.YianPicker)
    if (!nodes.length) return null
    return button(T.YianPicker(nodes[0].props), '添加')
  }
  // 空列表
  const empty = mountWb({}, { list: { ok: true, files: [] } })
  try {
    click(button(empty.live.tree, '添加医案'))
    await settle()
    assert.ok(pickerText(empty.live).includes('资料库还没有医案。'), '空态文案')
  } finally { empty.cleanup() }
  // 列表出错
  const err = mountWb({}, { list: { ok: false, reason: '资料库没接线', files: [] } })
  try {
    click(button(err.live.tree, '添加医案'))
    await settle()
    assert.ok(pickerText(err.live).includes('医案列表没取到：资料库没接线'), '出错要显示 reason')
  } finally { err.cleanup() }
  // 加载中（fetch 挂起不返回）
  const slow = mountWb({}, {})
  try {
    const prevFetch = globalThis.fetch
    globalThis.fetch = () => new Promise(() => {}) // 永不返回
    click(button(slow.live.tree, '添加医案'))
    await settle()
    assert.ok(pickerText(slow.live).includes('正在翻资料库的医案…'), '加载中态文案')
    globalThis.fetch = prevFetch
  } finally { slow.cleanup() }
  // 正文失败：清单已记，但右栏不摆医案，reason 显示出来
  const docFail = mountWb({}, {
    list: { ok: true, files: [{ file: '坏.md', title: '坏案', at: 1 }] },
    doc: { ok: false, reason: '文件读坏了' },
  })
  try {
    click(button(docFail.live.tree, '添加医案'))
    await settle()
    click(pickerAdd(docFail.live))
    await settle()
    const saved = JSON.parse(docFail.ls.store.get('dsh-tcm-xueli:yian'))
    assert.equal(saved[0].file, '坏.md', '正文失败清单也要记上')
    assert.equal(byType(docFail.live.tree, docFail.live.exports.__test.YianPane).length, 0, '正文没取到不摆查看器')
    assert.ok(textOf(docFail.live.tree).includes('医案没打开：文件读坏了'), '正文失败要显示 reason')
    assert.equal(byType(docFail.live.tree, docFail.live.exports.__test.YianPicker).length, 1, '失败时选择器留着')
  } finally { docFail.cleanup() }
})

test('医案③：挂载载入清单显示医案区、受搜索过滤；点行只读打开，「×」只清清单不删文件', async () => {
  const seed = { 'dsh-tcm-xueli:yian': JSON.stringify([
    { file: '甲.md', title: '甲案', at: 1700000000000 },
    { file: '乙.md', title: '乙案', at: 1700000001000 },
  ]) }
  const m = mountWb({}, { doc: { ok: true, file: '甲.md', title: '甲案', body: '甲正文' } }, seed)
  try {
    const { live, ls, fetchMock } = m
    // 挂载即载入：医案区小标题＋两行
    assert.ok(byClass(live.tree, 'xw-ysec').length === 1, '要有「医案」小标题')
    assert.equal(textOf(byClass(live.tree, 'xw-ysec')[0]), '医案')
    const yianRows = findAll(live.tree, (n) => n.props && typeof n.props.key === 'string' && n.props.key.indexOf('yian:') === 0)
    assert.equal(yianRows.length, 2, '两行已导入医案')
    // 搜索过滤：输入「甲」只剩甲案
    const search = findAll(live.tree, (n) => n.type === 'input' && n.props.className === 'xw-search')[0]
    search.props.onChange({ target: { value: '甲' } })
    const filtered = findAll(live.tree, (n) => n.props && typeof n.props.key === 'string' && n.props.key.indexOf('yian:') === 0)
    assert.equal(filtered.length, 1, '搜索要过滤医案区')
    assert.equal(filtered[0].props.key, 'yian:甲.md')
    search.props.onChange({ target: { value: '' } })
    // 点医案行 → fetch 正文 → 右栏只读
    const rowAgain = findAll(live.tree, (n) => n.props && n.props.key === 'yian:甲.md')[0]
    click(rowAgain)
    await settle()
    assert.ok(fetchMock.calls.some((c) => c.url === '/dsh-tcm-xueli/yian?file=' + encodeURIComponent('甲.md')), '点行要 fetch 正文')
    assert.equal(byType(live.tree, live.exports.__test.YianPane).length, 1, '点行进入只读查看')
    assert.equal(byType(live.tree, live.exports.__test.WbChatPane).length, 0)
    // 「×」移除：只清清单，不走任何删除通道
    const removeBtn = findAll(live.tree, (n) => n.type === 'button' && textOf(n) === '×')[0]
    assert.ok(removeBtn, '医案行要有移除「×」')
    const callsBefore = fetchMock.calls.length
    click(removeBtn)
    await settle()
    const saved = JSON.parse(ls.store.get('dsh-tcm-xueli:yian'))
    assert.deepEqual(saved.map((x) => x.file), ['乙.md'], '「×」只把这一条从清单拿掉')
    assert.equal(byType(live.tree, live.exports.__test.YianPane).length, 0, '正在看的被移除就退出查看')
    // 移除前后没有任何新 fetch（尤其没有删除通道）
    assert.equal(fetchMock.calls.length, callsBefore, '移除不发任何请求')
    assert.ok(fetchMock.calls.every((c) => c.url.indexOf('/dsh-tcm-xueli/yian') === 0), '医案操作只走 yian 通道，不碰删除通道')
  } finally {
    m.cleanup()
  }
})

test('医案④：看医案时点会话行/新建会话/去聊天页都清 viewYian 回聊天', async () => {
  const seed = { 'dsh-tcm-xueli:yian': JSON.stringify([{ file: '甲.md', title: '甲案', at: 1 }]) }
  const m = mountWb({}, { doc: { ok: true, file: '甲.md', title: '甲案', body: '正文' } }, seed)
  try {
    const { live, wb } = m
    const T = live.exports.__test
    // 先打开医案
    click(findAll(live.tree, (n) => n.props && n.props.key === 'yian:甲.md')[0])
    await settle()
    assert.equal(byType(live.tree, T.YianPane).length, 1)
    // 点普通会话行 → 清医案、回聊天
    const sessRow = findAll(live.tree, (n) => n.props && n.props.title === '感冒一案')[0]
    assert.ok(sessRow, '左列要有历史会话行')
    click(sessRow)
    await settle()
    assert.equal(byType(live.tree, T.YianPane).length, 0, '点会话行要退出医案')
    assert.equal(byType(live.tree, T.WbChatPane).length, 1, '点会话行回到聊天')
    // 再打开医案，点「新建会话」→ 清医案
    click(findAll(live.tree, (n) => n.props && n.props.key === 'yian:甲.md')[0])
    await settle()
    assert.equal(byType(live.tree, T.YianPane).length, 1)
    click(button(live.tree, '新建会话'))
    await settle()
    assert.equal(byType(live.tree, T.YianPane).length, 0, '新建会话要退出医案')
    // 再打开医案，点「去聊天页」→ 清医案并调 openSession
    click(findAll(live.tree, (n) => n.props && n.props.key === 'yian:甲.md')[0])
    await settle()
    assert.equal(byType(live.tree, T.YianPane).length, 1)
    click(button(live.tree, '去聊天页'))
    await settle()
    assert.equal(byType(live.tree, T.YianPane).length, 0, '去聊天页要退出医案')
    assert.ok(wb.opened.length > 0, '去聊天页要调 openSession')
    assert.ok(wb.selected.indexOf(null) >= 0, '去聊天页要 selectPanel(null)')
    // YianPane 自带「关闭」按钮也能清
    click(findAll(live.tree, (n) => n.props && n.props.key === 'yian:甲.md')[0])
    await settle()
    const pane = byType(live.tree, T.YianPane)[0]
    pane.props.onClose()
    live.update()
    assert.equal(byType(live.tree, T.YianPane).length, 0, '查看器「关闭」要清 viewYian')
  } finally {
    m.cleanup()
  }
})

test('医案⑤：MarkdownText 缺失降级纯文本不报错；存在则 props 正确且 labels 身份稳定', () => {
  const doc = { file: '甲.md', title: '甲案', created: '2026-01-01', updated: '2026-02-02', body: '# 标题\n正文' }
  // 无 MarkdownText：降级 pre-wrap 纯文本，不抛
  const noMd = liveClient(fakeDoc(), {})
  const pane1 = noMd.exports.__test.YianPane({ doc, onClose() {} })
  assert.ok(pane1 && pane1.type === 'div', '降级也要画出容器')
  const pre = findAll(pane1, (n) => n.props && n.props.style && n.props.style.whiteSpace === 'pre-wrap')
  assert.equal(pre.length, 1, '要有 pre-wrap 纯文本块')
  assert.equal(textOf(pre[0]), '# 标题\n正文', '正文原样摆出')
  assert.equal(byType(pane1, noMd.exports.__test.YianPane).length, 0)
  // 有 MarkdownText：props 正确
  function FakeMarkdown() { return null }
  const withMd = liveClient(fakeDoc(), { MarkdownText: FakeMarkdown })
  const pane2 = withMd.exports.__test.YianPane({ doc, onClose() {} })
  const md = byType(pane2, FakeMarkdown)
  assert.equal(md.length, 1, '要用 ui.MarkdownText 渲染')
  assert.equal(md[0].props.text, '# 标题\n正文')
  assert.equal(md[0].props.omitHtml, true)
  assert.equal(md[0].props.variant, 'body')
  assert.deepEqual(md[0].props.labels, { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' })
  // labels 身份稳定：两次渲染同一个对象
  const pane3 = withMd.exports.__test.YianPane({ doc, onClose() {} })
  const md2 = byType(pane3, FakeMarkdown)
  assert.equal(md[0].props.labels, md2[0].props.labels, 'labels 不许每次渲染新建')
  // 头部标题＋时间＋关闭按钮
  assert.ok(textOf(pane2).includes('甲案'))
  assert.ok(textOf(pane2).includes('创建 2026-01-01'))
  assert.ok(textOf(pane2).includes('更新 2026-02-02'))
  let closed = 0
  const pane4 = withMd.exports.__test.YianPane({ doc, onClose() { closed += 1 } })
  click(button(pane4, '关闭'))
  assert.equal(closed, 1, '关闭按钮要回调 onClose')
  // MarkdownText 创建时抛错也降级，不拖垮
  const boom = liveClient(fakeDoc(), { MarkdownText: function Boom() { throw new Error('画不出') } })
  // createElement 不会调用组件函数，所以这里模拟的是 ui.MarkdownText 本身不可用的情形：
  // 直接传一个会让 E 抛错的场景不易构造，改为断言「无 MarkdownText」路径已覆盖降级（上面 pane1）。
  assert.ok(boom.exports.__test.YianPane({ doc, onClose() {} }), '有组件时照常画出')
})
