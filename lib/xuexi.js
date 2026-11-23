/**
 * 学习版 · 经方（学习版）这一块的全部代码
 *
 * 只管三件事，跟模拟问诊没有任何来往：
 * 1. 提示词变量：资料库目录、时令、五运六气、口径锁，都以变量形式交给会话；
 * 2. 出口校验：回答里出现克数（含 g）就把「数字＋单位」遮成 *，药名与句子骨架原样留着；
 * 3. 资料库维护：补随包经典、生成 索引.md、根目录新书归类、会话归档 医案/、开只读检索页。
 *
 * 这里任何一个环节出错，都只记日志、退回只靠提示词约束，绝不影响 DSH 主体启动，
 * 也绝不牵扯模拟问诊那一块（两块各管各的，见 lib/sim.js）。
 */
import { existsSync, watch } from 'node:fs'
import { join } from 'node:path'
import { INDEX_FILE, writeIndex, normalizeRoot, ensureCategoryDirs } from './kb-index.js'
import { ensureCorpus } from './corpus.js'
import { createSessionRecorder } from './records.js'
import { autoFileBooks } from './auto-file.js'
import { blotDosage, hasDosage, quoteSafeCut } from './dosage-guard.js'
import { GEAR_GUARD, GEAR_GUARD_VAR, KB_PATH_VAR, SEASON_VAR, WUYUN_VAR } from './gear.js'
import { seasonText, wuyunText } from './season.js'
import { looksTcmPrompt, tcmVerdict, versionOf, isTcmSession as looksTcmSession } from './guard.js'
import { mountSearchRoute } from './search.js'
import { mountAcupointRoute } from './acupoints.js'
import { mountArtRoute } from './artwork.js'
import { mountTeachRoute } from './teach.js'
import { mountYianRoute } from './yian.js'
import { dashangBlock, hasGiftSign, missingDisclaimer } from './dashang.js'

/** 不预设资料库目录：用户没在设置页填，就什么都不做，不替对方挑目录。 */
export const DEFAULT_KB = ''

/** 启动后稍等再建索引：先让主体起来，别和启动抢磁盘。 */
const STARTUP_DELAY = 2500
/** 配置重读间隔：目录监视没挂上时（兜底路径），设置页改路径后最多等这么久就生效。 */
const POLL_DELAY = 3000
/** 目录监视已挂上时，轮询只做兜底，间隔拉长，别每 3 秒扫一遍盘。 */
const POLL_DELAY_WATCHED = 15000
/** 目录变动后的去抖时间，避免复制一本书时反复重写。 */
const REBUILD_DELAY = 1500
/** 出口校验每次只查末尾这么多个字：够抓到刚冒出来的剂量，又不吃内存。 */
const SCAN_WINDOW = 600

/* ────────────────────── 强制提问（模型不问就由代码问） ────────────────────── */

/**
 * 问诊清单：十项问诊的代码版。模型没先问时，挑还没答到的几项，拼成一张问诊卡。
 * 每项只写「问什么＋照着答的例子」，不预设答案，也不替模型下证。
 */
const ASK_ITEMS = [
  { q: '哪儿最难受、多久了？', ex: '例：胃胀，饭后明显，两个多月', test: /(疼|痛|胀|晕|眩|咳|喘|闷|烦|痒|麻|烧|吐|泻|秘|堵|不适|难受)/ },
  { q: '怕冷还是怕热？手脚凉不凉？', ex: '例：怕冷，手脚凉（可选：怕热／忽冷忽热／不明显）', test: /(怕冷|畏寒|怕热|手脚凉|手足凉|发热|低烧|寒热|身上热|五心)/ },
  { q: '出汗多不多？睡着以后出不出汗？', ex: '例：白天一动就汗，夜里不出（可选：自汗／盗汗／无汗）', test: /(出汗|汗多|无汗|盗汗|自汗|冒汗)/ },
  { q: '大便几天一次？干还是稀？', ex: '例：两天一次，开头干，后面软', test: /(大便|排便|便秘|拉稀|腹泻|溏|干结|不通)/ },
  { q: '小便黄不黄、次数多不多、夜里起几次？', ex: '例：白天四五次，夜里一次，色偏黄', test: /(小便|尿|起夜)/ },
  { q: '胃口怎么样？吃了胀不胀、嘴里什么味？', ex: '例：能吃，饭后胀，早上口苦（可选：不想吃／口干／口淡）', test: /(胃口|食欲|吃饭|想吃|腹胀|口苦|口干|口淡|恶心)/ },
  { q: '睡得怎么样？多久能睡着、夜里醒不醒？', ex: '例：入睡难，夜里醒两回（可选：易醒／多梦／早醒）', test: /(睡眠|睡不着|失眠|入睡|易醒|多梦|早醒|睡不好)/ },
  { q: '舌头什么样？照着镜子看一眼。', ex: '例：舌偏淡、边上有齿痕、苔白薄', test: /(舌|苔)/ },
  { q: '脉摸不准就说这几处感觉：手脚凉热、心慌不慌、累不累。', ex: '例：手脚凉，不怎么心慌，容易累', test: /(脉|心慌|乏力|气短|手脚)/ },
]

/** 每个会话最近说过的话（只听真人发言）；内存里只存最近 200 个会话。 */
const TALK = new Map()

/** 取某个会话的问诊状态；没有就新开一个，存太多就丢最早那个。 */
function talkState(sessionId) {
  const key = String(sessionId || '')
  if (key === '') return { user: [], clue: false }
  let state = TALK.get(key)
  if (!state) {
    state = { user: [], clue: false }
    TALK.set(key, state)
    while (TALK.size > 200) TALK.delete(TALK.keys().next().value)
  }
  return state
}

/** 从消息内容里取纯文字：字符串照收，分段内容只拼文字段。 */
function plainText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
      parts.push(part.text.trim())
    }
  }
  return parts.join('\n').trim()
}

/**
 * 拼一张问诊卡：只问还没答到的项，最多五条。
 * 对方已经说过「不用问」「直接点评」的，返回空——那种场面交给提示词里的 21.7，不硬塞问卷。
 */
export function forcedAskCard(userText) {
  const text = String(userText || '')
  if (/(不用问|别问|不要问|直接说|直接讲|直接点评|帮我点评|看看这个方|这个方子|这张方)/.test(text)) return ''
  const missing = ASK_ITEMS.filter((item) => !item.test.test(text)).slice(0, 5)
  const list = missing.length > 0 ? missing : ASK_ITEMS.slice(0, 3)
  const lines = ['**先把这几样说清，我再往下讲**（这一轮没先问，按编号答就行）', '']
  list.forEach((item, index) => {
    lines.push(String(index + 1) + '. ' + item.q)
    lines.push('   ' + item.ex)
  })
  lines.push('')
  lines.push('答完这几条，我按「手上的线索 → 六经与时令 → 七段」往下讲。')
  return lines.join('\n')
}

/** 正在监视的目录（全局共享）：同一个库只挂一份监视，重复加载本插件时也不重复挂。 */
const WATCHERS = new Map()
/** 同一秒里多次要求重建索引时，排个队，避免互相把临时文件冲掉。 */
let rebuildChain = Promise.resolve()

/* ────────────────────────── 小工具 ────────────────────────── */

/** 读配置项；读不到给 undefined，不抛异常。 */
function readValue(config, key) {
  try {
    const raw = config && config[key]
    const value = raw && typeof raw.get === 'function' ? raw.get() : raw
    return value === undefined || value === null ? undefined : value
  } catch (error) {
    return undefined
  }
}

/**
 * 「目录在不在盘上」的短缓存：提示词变量与轮询一轮里会反复问同一个目录，
 * 成功结果缓存 1 秒就够省掉重复 syscall；失败不缓存，用户刚建好的目录立刻能认出来。
 */
const PATH_TTL = 1000
let pathSeen = { dir: '', at: 0 }
function dirReady(dir) {
  if (dir === '') return false
  const now = Date.now()
  if (dir === pathSeen.dir && now - pathSeen.at < PATH_TTL) return true
  const ok = existsSync(dir)
  if (ok) pathSeen = { dir, at: now }
  return ok
}

/** 当前资料库目录：用户填了就用填的，没填返回空串（调用方见到空串必须什么都别做）。 */
export function currentPath(config) {
  const raw = readValue(config, 'kbPath')
  if (typeof raw === 'string' && raw.trim() !== '') {
    const dir = resolveUserDir(raw)
    // 只认设置里填的那一个目录，而且它得真的在盘上：
    // 目录不在、或者填错了，就当没配置——绝不拿这个路径去外面找替代目录。
    return dir !== '' && dirReady(dir) ? dir : ''
  }
  return DEFAULT_KB
}

/**
 * 设置框里的路径可能被输入法吃掉反斜杠（D:\中医工作区\中医资料库 变成
 * D:中医工作区中医资料库），也可能盘符大小写不对。这里只做还原，不换目录：
 * ①原样能读到就直接用；②Windows 上 D:xxx、D:/xxx、D:\xxx 三种写法都试同一段文字；
 * ③盘符大小写换一遍再试。全都不行就返回 ''，绝不去别的目录找替代。
 */
export function resolveUserDir(raw) {
  const text = String(raw).trim()
  const tries = []
  const push = (value) => {
    const dir = normalizeRoot(value)
    if (dir !== '' && !tries.some((x) => x.toLowerCase() === dir.toLowerCase())) tries.push(dir)
  }
  push(text)
  if (process.platform === 'win32') {
    const drive = /^([A-Za-z]):/.exec(text)
    if (drive) {
      const rest = text.slice(2).replace(/^[\\/]+/, '')
      const letter = drive[1].toUpperCase()
      for (const head of [letter + ':', letter + ':/', letter + ':/' + '\\']) {
        push(head + rest)
      }
    }
    const lowered = text.replace(/^([A-Za-z]):/, (all, d) => d.toLowerCase() + ':')
    push(lowered)
    const raised = text.replace(/^([A-Za-z]):/, (all, d) => d.toUpperCase() + ':')
    push(raised)
  }
  for (const dir of tries) {
    try {
      if (existsSync(dir)) return dir
    } catch (error) {
      // 单个写法检查失败就跳过
    }
  }
  return ''
}

/* ────────────────────────── 索引 ────────────────────────── */

/** 重建一次索引；失败只记日志，不抛给主体。多次触发时排队执行，避免同时写盘。 */
function rebuild(state, dir, ctx, reason) {
  rebuildChain = rebuildChain
    .then(() => {
      const result = writeIndex(dir, new Date(), ctx?.logger)
      if (result.reason === 'root-missing') {
        ctx?.logger?.warn?.('学理模式：资料库目录不存在，跳过索引生成：%s', dir)
        return
      }
      if (result.reason === 'user-file') {
        // writeIndex 已经 warn 过一次，这里不再重复；索引不生成时至少让用户知道原因。
        return
      }
      if (result.capped) {
        ctx?.logger?.warn?.('学理模式：书目已达索引上限（%d 个），后面的书没有进索引；请分目录或精简资料库。', result.files)
      }
      if (result.changed) {
        ctx?.logger?.info?.('学理模式：已重建 %s（%s，共 %d 个文件）', INDEX_FILE, join(dir, INDEX_FILE), result.files)
      } else if (reason === 'startup') {
        ctx?.logger?.info?.('学理模式：%s 已是最新，共 %d 个文件', INDEX_FILE, result.files)
      }
    })
    .catch((error) => {
      ctx?.logger?.warn?.('学理模式：索引生成失败（不影响会话）：%o', error)
    })
  return rebuildChain
}

/** 关掉本插件挂的那份监视；别的插件还挂着同一目录时保留不动。 */
function closeWatchers(state) {
  const current = state.watcher
  state.watcher = null
  state.mode = ''
  if (current && typeof current.release === 'function') {
    try {
      current.release()
    } catch (error) {
      // 关不掉也无所谓，下次启动会重新挂。
    }
  }
}

/** 挂一个目录监视；平台不支持这种监视方式时返回 null，交给调用方降级。 */
function watchOne(target, recursive, onChange, ctx) {
  try {
    const handle = watch(target, { recursive, persistent: false }, onChange)
    handle.on?.('error', (error) => {
      ctx?.logger?.warn?.('学理模式：目录监视出错，索引改为启动时生成：%o', error)
    })
    if (handle.unref) handle.unref()
    return handle
  } catch (error) {
    return null
  }
}

/** 不支持递归监视时的退路：单层盯根目录、text/、skills/ 与五个分类文件夹。 */
function watchShallow(dir, onChange, ctx) {
  const handles = []
  for (const sub of ['', 'text', 'skills', 'skills/tcm-jingfang', '经典', '经典注解', '名著', '医案', '方药']) {
    const target = sub === '' ? dir : join(dir, sub)
    if (!existsSync(target)) continue
    const handle = watchOne(target, false, onChange, ctx)
    if (handle) handles.push(handle)
  }
  if (!handles.length) return null
  return {
    name: 'shallow',
    close() {
      for (const handle of handles) {
        try {
          handle.close()
        } catch (error) {
          // 单个关不掉不影响其它的。
        }
      }
    },
  }
}

/** 去抖后重建，避免一次批量复制触发十几次写盘。 */
function scheduleRebuild(state, dir, ctx, reason) {
  if (state.debounce) clearTimeout(state.debounce)
  state.debounce = setTimeout(() => {
    state.debounce = null
    if (!state.active) return
    try {
      autoFileBooks(dir, { logger: ctx?.logger, cache: state.autoFileCache })
    } catch (error) {
      ctx?.logger?.warn?.('学理模式：自动归类失败（不影响索引）：%o', error)
    }
    rebuild(state, dir, ctx, reason)
    if (state.mode === 'shallow') {
      try {
        watchDir(state, dir, ctx, true)
      } catch (error) {
        // 挂不上就等下次轮询时再试。
      }
    }
  }, REBUILD_DELAY)
  if (state.debounce.unref) state.debounce.unref()
}

/** 只关心书目增删改，自己写的 索引.md 不触发重建。 */
function isNoise(filename) {
  if (!filename) return false
  const name = String(filename)
  return name === INDEX_FILE || name.endsWith(INDEX_FILE + '.tmp') || name.startsWith('.~') || name.startsWith('~$')
}

/**
 * 切换监视目录：路径改了就把旧的关掉，换成新的。
 * 同一个库只挂一份监视——已经挂着就登记一下共用，不再重复挂；
 * 谁先挂上，目录变化产生的索引重建就由谁先做，写出来的都是同一份 索引.md，内容一致。
 */
function watchDir(state, dir, ctx, force = false) {
  if (!state.active) return
  if (!force && state.dir === dir && state.watcher) return
  closeWatchers(state)
  state.dir = dir
  if (!existsSync(dir)) return

  const shared = WATCHERS.get(dir)
  if (shared) {
    // Set#add 返回集合本身，不是元素；先加再留引用，否则 release 删错对象，
    // holders 永远清不空，共享监视从此关不掉。
    shared.holders.add(state)
    const holder = state
    shared.release = () => {
      shared.holders.delete(holder)
      if (shared.holders.size === 0) {
        WATCHERS.delete(dir)
        try {
          shared.handle?.close?.()
        } catch (error) {
          // 关不掉不影响其它。
        }
      }
    }
    state.watcher = { release: shared.release }
    state.mode = shared.mode
    return
  }

  const onChange = (event, filename) => {
    if (isNoise(filename)) return
    scheduleRebuild(state, dir, ctx, 'change')
  }
  let handle = watchOne(dir, true, onChange, ctx)
  let mode = 'recursive'
  if (!handle) {
    handle = watchShallow(dir, onChange, ctx)
    mode = handle ? 'shallow' : ''
  }
  if (!handle) {
    ctx?.logger?.warn?.('学理模式：目录监视启动失败，索引只在插件启动时生成：%s', dir)
    return
  }

  const record = { handle, mode, holders: new Set([state]), release: null }
  record.release = () => {
    record.holders.delete(state)
    if (record.holders.size === 0) {
      WATCHERS.delete(dir)
      try {
        handle?.close?.()
      } catch (error) {
        // 关不掉不影响其它。
      }
    }
  }
  WATCHERS.set(dir, record)
  state.watcher = record
  state.mode = mode
}

/** 读取当前路径与开关，必要时切换监视、补书、重建索引。 */
function sync(state, ctx, config, reason) {
  if (!state.active) return
  const dir = currentPath(config)
  const autoIndex = readValue(config, 'autoIndex') !== false
  // 库根锁定：记下这次用的到底是设置里填的那个目录，改了要看得见。
  if (dir !== state.lockedDir) {
    state.lockedDir = dir
    if (dir !== '') ctx?.logger?.info?.('学理模式：资料库锁定在 %s（来自设置里的 kbPath）', dir)
    else ctx?.logger?.info?.('学理模式：设置里还没填资料库路径，索引与归档一律不做')
  }

  // 目录存在才补资料；不存在不擅自建目录，避免把工具路径写错成资料库。
  let autoMoved = 0
  if (existsSync(dir)) {
    try {
      const made = ensureCategoryDirs(dir)
      if (made > 0) ctx?.logger?.info?.('学理模式：已建立 %d 个分类文件夹：%s', made, dir)
      const copied = ensureCorpus(dir)
      if (copied > 0) ctx?.logger?.info?.('学理模式：已补齐 %d 本随包经典到 %s', copied, join(dir, 'text'))
    } catch (error) {
      ctx?.logger?.warn?.('学理模式：资料库初始化失败（不影响会话）：%o', error)
    }

    try {
      const filed = autoFileBooks(dir, { logger: ctx?.logger, cache: state.autoFileCache })
      autoMoved = filed.moved
    } catch (error) {
      ctx?.logger?.warn?.('学理模式：自动归类失败（不影响会话）：%o', error)
    }
  }

  if (!autoIndex) {
    closeWatchers(state)
    if (state.debounce) {
      clearTimeout(state.debounce)
      state.debounce = null
    }
    state.dir = ''
    state.autoIndex = false
    retunePoll(state, ctx, config)
    return
  }

  const pathChanged = state.dir !== dir
  const autoChanged = state.autoIndex !== true
  state.dir = dir
  state.autoIndex = true

  if (pathChanged || autoChanged || reason === 'startup' || autoMoved > 0) rebuild(state, dir, ctx, reason)
  watchDir(state, dir, ctx, pathChanged || autoChanged)
  retunePoll(state, ctx, config)
}

/** 配置核对：路径与开关都没动就直接返回，不每 3 秒扫一遍资料库。 */
function syncIfChanged(state, ctx, config) {
  if (!state.active) return
  const dir = currentPath(config)
  const autoIndex = readValue(config, 'autoIndex') !== false
  if (dir === state.dir && autoIndex === state.autoIndex) return
  sync(state, ctx, config, 'config')
}

/**
 * 轮询节奏跟着监视状态走：目录监视挂上了就放慢到 15 秒（只是兜底，改动由监视即时触发）；
 * 监视没挂上（平台不支持、目录暂不存在）才用 3 秒，保证设置页改路径能及时生效。
 */
function retunePoll(state, ctx, config) {
  if (!state.active) return
  const delay = state.watcher ? POLL_DELAY_WATCHED : POLL_DELAY
  if (state.pollDelay === delay) return
  state.pollDelay = delay
  if (state.poll) clearInterval(state.poll)
  state.poll = setInterval(() => syncIfChanged(state, ctx, config), delay)
  if (state.poll.unref) state.poll.unref()
}

/* ────────────────────────── 提示词 ────────────────────────── */

/**
 * 资料库路径的呈现：给完整的绝对路径，并说明它是什么。
 * 只报目录名是不行的：模型会满盘去找同名文件夹，盘上还有别的「资料库」就会读错库。
 */
function kbText(config) {
  const dir = currentPath(config)
  if (!dir) {
    return '（还没配置资料库：请提醒用户到「设置 → 中医 · 经方（学习版）｜资料库目录」里填一个资料库目录，填之前不要引书讲方、不要报方名）'
  }
  // 必须给完整的绝对路径：只给文件夹名，模型会满盘去找同名目录，
  // 一旦盘上还有别的「资料库」，就会读错库。
  try {
    if (!existsSync(dir)) {
      return `（${dir} 当前不可用：请提醒用户到「设置 → 中医 · 经方（学习版）｜资料库目录」里改路径）`
    }
  } catch (error) {
    // 检查失败时照常给路径，不阻断会话。
  }
  return dir
}
/**
 * 判断一个流块是不是「工具调用」。
 *
 * 宿主真正的流里，工具调用不是 `type: 'tool-call'` 一种：
 * 开始是 `block-start` + `blockType: 'tool-call'`，参数是 `tool-call-delta`，
 * 收块是 `block-end` + `block.type: 'tool-call'`。
 * 早先只认 `type: 'tool-call'`，所以 `sawTool` 永远是 false——每个中间步骤
 * 都被当成最终回答，末尾的免责声明和打赏被反复补，用户看到的就是「提前出来、两遍」。
 */
export function isToolChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  return chunk.type === 'tool-call'
    || chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    || (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call')
}

export function applyXuexi(ctx, config, api) {
  const name = api.name
  const state = {
    active: true,
    watcher: null,
    mode: '',
    dir: '',
    debounce: null,
    startup: null,
    poll: null,
    pollDelay: 0,
    autoIndex: undefined,
    autoFileCache: new Map(),
    // 最近一次锁定的库根：只用于日志，判断路径变了没有。
    lockedDir: undefined,
  }

  const dispose = () => {
    if (!state.active) return
    state.active = false
    if (state.debounce) clearTimeout(state.debounce)
    if (state.startup) clearTimeout(state.startup)
    if (state.poll) clearInterval(state.poll)
    closeWatchers(state)
  }
  // Cordis 卸载插件时调用返回的函数，watcher / timer 不会留在进程里。
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  } catch (error) {
    ctx.logger?.warn?.('学理模式：清理钩子注册失败：%o', error)
  }

  // 强制提问用得到「对方到底答了哪些」：只听 session/event 里的真人发言，不碰主链。
  // 记不下来也只是退回通用问诊卡，绝不影响回答。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        try {
          if (!event || event.type !== 'user/message') return
          if (event.data?.source?.kind !== 'user') return
          const id = session?.id
          if (!id) return
          const text = plainText(event.data?.content)
          if (text === '') return
          const state = talkState(id)
          state.user.push(text)
          while (state.user.length > 8) state.user.shift()
        } catch (error) {
          /* 记不下就算了，卡片退回通用那几条 */
        }
      })
    }
  } catch (error) {
    ctx.logger?.warn?.('学理模式：记用户发言失败（强制提问退回通用问诊卡）：%o', error)
  }

  // 回答自动归档：只旁听 session/event，不把逻辑塞进 agent 请求主链。
  try {
    if (typeof ctx.on === 'function' && typeof ctx.effect === 'function') {
      const recorder = createSessionRecorder({
        getKb: () => currentPath(config),
        currentPreset: (session) => {
          try {
            const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
            return registry?.presetForSession?.(session)
          } catch (error) {
            return undefined
          }
        },
        getTitle: (session) => {
          try {
            const titles = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
            const snapshot = titles?.get?.(session)
            return typeof snapshot === 'string' ? snapshot : snapshot?.title
          } catch (error) {
            return undefined
          }
        },
        logger: ctx.logger,
      })
      ctx.effect(() => ctx.on('session/event', recorder))
    }
  } catch (error) {
    ctx.logger?.warn?.('学理模式：回答自动归档注册失败（不影响会话）：%o', error)
  }

  /* ── 1. 三个提示词变量（只在中医会话里生效） ── */

  /**
   * 注册一个提示词变量。重载插件时同一个名字会再注册一次，
   * 这种情况属正常，不报错；只有名字没注册过、注册又失败，才记一条明确的告警。
   */
  const defineVar = (key, valueOf, label) => {
    try {
      ctx.systemPrompt.variable(key, valueOf)
    } catch (error) {
      const message = String((error && error.message) || error)
      // 热重载时同一个名字会再注册一次，报「已存在」属正常情况，不当故障。
      if (/exist|duplicate|already|重复|已存在/i.test(message)) {
        ctx.logger?.info?.('学理模式：%s 已存在，沿用现有定义', label)
        return
      }
      ctx.logger?.warn?.('学理模式：%s 注册失败：%s', label, message)
    }
  }

  // 注意：这里不能按「是不是中医会话」判断。组装提示词时上下文里没有 agent/session，
  // isTcmContext 会一律判成「不是」，变量就成空串，模型手里根本没路径，于是满盘去找同名文件夹。
  // 这三个变量只有中医预设的 persona 会引用，别的预设不会碰，直接给值即可。
  defineVar(KB_PATH_VAR, () => kbText(config), '资料库路径变量')
  // 时令：每次请求现算当下季节与节气。天气取不到，规矩里写明靠问答问用户。
  defineVar(SEASON_VAR, () => seasonText(), '时令变量')
  defineVar(WUYUN_VAR, () => wuyunText(), '五运六气变量')
  // 口径锁变量：预设 persona 第一行引用它；不引用就不会进提示词，不存在「第二份」。
  // 不能按「是不是中医会话」判断——组装时上下文里没有 agent/session，判断只会得到「不是」。
  // 这里的变量只有本预设的 persona 会引用，别的预设不会碰。
  defineVar(GEAR_GUARD_VAR, () => GEAR_GUARD, '口径锁变量')

  /* ── 1.5 只有在中医会话真正开始时，才检查资料库路径 ── */
  // 提醒单开一块，放在最前面（index 用 0，正文依次往后挪一位），不跟正文抢位置。
  const NOTICE_BLOCK = 0
  // 一个会话提醒一次就够，记在这里，别每问一句都念一遍。
  const kbNoticed = new Set()
  // 打赏区也按会话记：一个会话只摆一次，后面再给分析、再讲一遍都不重复摆。
  const giftOnce = new Set()
  // 不填路径不是错误，只是这个会话没法按原文引书：开场先提醒一句，免得他自己犯迷糊。
  // 每个会话只提醒一次；不是中医预设的会话一句都不说，不打扰别人。
  const kbNotice = (sessionId, systemText) => {
    try {
      // 全量版会话有它自己的提醒，学习版一个字都不多说。
      if (versionOf(ctx, sessionId) === 'full') return
      if (!looksTcmSession(ctx, sessionId, name) && !looksTcmPrompt(systemText)) return
    } catch (error) {
      return
    }
    const dir = currentPath(config)
    if (dir !== '') return
    if (kbNoticed.has(sessionId)) return
    kbNoticed.add(sessionId)
    // 只记最近 200 个会话，跑久了不占内存。
    if (kbNoticed.size > 200) kbNoticed.delete(kbNoticed.values().next().value)
    // 填了路径但目录现在不存在（盘符变了、文件夹改名/删了）和「压根没填」是两回事，提示要分开说。
    const raw = String(config?.kbPath ?? '').trim()
    let text
    if (raw === '') {
      text = '⚠️ 这是第一次用：还没设定资料库目录，所以这一回答不引书、不报方名，只给治法方向。'
        + '去「设置 → 中医 · 经方（学习版）｜资料库目录」里填一个目录再点保存（新建一个空文件夹就行，哪个盘都可以），'
        + '填好之后再问，就能按原文引书讲方了。'
    } else {
      text = '⚠️ 资料库目录填的是「' + raw + '」，但这个文件夹现在不存在（可能被删、改名或换了盘），所以这一回答不引书、不报方名，只给治法方向。'
        + '去「设置 → 中医 · 经方（学习版）｜资料库目录」改成现在确实存在的那个文件夹，再点保存。'
    }
    ctx.logger?.warn?.('学理模式：资料库目录%s，已在本会话开头提醒', raw === '' ? '未设定' : '不存在')
    return text
  }

  /* ── 2. 出口校验：只在中医会话里遮掉剂量数值 ── */
  // 只做一件事：回答里出现具体剂量的那一截（数字＋单位）换成 *，其余照常输出。
  // 早先是「命中即截断整条回答」，一句冒了剂量，前面上千字的辨证全废；后来改成按句挖掉，
  // 又连药名带治法一起吞了。现在只遮数值：桂枝 9 克 → 桂枝*，句子骨架和药名都留着。
  // 列表项前缀、引号里的原文不碰（判据见 dosage-guard.js 的 doseSpans）。
  // 也不再往回答里追加任何提醒句（早先那段提醒会另开一块，界面上看着像把正文顶掉，用户要求去掉）。
  const stream = async function* (options, next, hint) {
        // 文字与推理两条通道各攒各的队列、各记各的前文尾巴，互不串味。
        // 尾巴上挂一段已判过的文字再判，是为了认出「其方桂枝三两」这类要看前文的剂量。
        const bufs = { text: { queue: '', tail: '' }, reasoning: { queue: '', tail: '' } }
        // 会话是不是中医：第一次判出剂量时才去认；认不出就看这次请求的提示词，
        // 提示词里也没有学理模式总纲的，说明不是中医会话，一律原样放行。
        let mode = 'unknown'
        const isTcmSession = () => {
          if (mode === 'unknown') {
            const { decided, tcm } = verdict()
            // 会话记录说是中医，直接认；说不是、或者认不出，都再看这次请求的提示词——
            // 提示词里带着学理模式总纲，就说明这次组装的确实是中医会话（入口也是这么判的），
            // 不能因为宿主没拿到会话对象就把口径全关掉。
            let version = ''
            try {
              version = versionOf(ctx, options?.sessionId)
            } catch (error) {
              version = ''
            }
            if (version === 'full') mode = 'other'
            else if (decided && tcm) mode = 'tcm'
            else mode = looksTcmPrompt(options?.system) ? 'tcm' : 'other'
          }
          return mode === 'tcm'
        }
        const verdict = () => tcmVerdict(ctx, options?.sessionId, name)
        // 流里的 chunk 必须始终是对象：宿主累加器 switch(chunk.type) 遇到字符串直接抛
        // unreachable variant in AssistantStreamAccumulator.push，整轮回答作废。
        // 抽出来的每一段文字一律由这里包成 text-delta 对象再发，绝不裸发字符串。
        let lastChunk = null
        let lastReasoning = null
        const delta = (base, text, kind) => ({ ...(base || null), type: kind === 'reasoning' ? 'reasoning-delta' : 'text-delta', text })
        // 强制提问的闸门：还没决定「放行还是换卡」时先把文字压住，判出来再吐。
        // 放行——写了「手上的线索」（动笔轮），或者这一轮确实在问（有问号）；
        // 换卡——直接开讲七段，或者压了 400 字还不问也不写线索。
        let gate = null
        const clueOpen = /##\s*手上的线索/
        const draftOpen = /(辨证定位|治则治法|代表方|推荐穴位|配伍禁忌|药典用量|六经与时令|君臣佐使|方证)/
        const askSign = /[？?]/
        const send = function* (base, piece, kind) {
          // 推理通道不拦：那段是模型自己的思考，不是给对方看的回答。
          if (!gate || kind === 'reasoning') {
            yield delta(base, piece, kind)
            return
          }
          if (base && typeof base.index === 'number') gate.index = base.index
          if (gate.mode === 'replace') return
          if (gate.mode === 'pass') {
            yield delta(base, piece, kind)
            return
          }
          gate.hold += piece
          if (clueOpen.test(gate.hold)) {
            gate.mode = 'pass'
            try { talkState(options?.sessionId).clue = true } catch (error) { /* 记不下不影响 */ }
            yield delta(base, gate.hold, kind)
            return
          }
          if (draftOpen.test(gate.hold)) {
            gate.mode = 'replace'
            return
          }
          if (askSign.test(gate.hold)) {
            gate.mode = 'pass'
            yield delta(base, gate.hold, kind)
            return
          }
          if (gate.hold.length > 400) {
            gate.mode = 'replace'
          }
        }
        // 把队列里判过的那一段吐出去（force 时连尾巴一起吐完），吐的是对象。buf 指明用哪条通道的队列。
        const take = function* (force, base, buf, kind) {
          if (buf.queue === '') return
          let cut = force ? buf.queue.length : -1
          if (!force) {
            // 列表块（行首「1. 」「- 」）整块攒到空行再判：一行一句也照样算同一段，
            // 才认得出「这一段整段是列表」；其余正文照旧按句末标点切，逐句吐，不拖。
            if (/^\s*(?:\d+[.、]\s|[-*+]\s)/.test(buf.queue)) {
              const blank = buf.queue.search(/\n[ \t]*\n/)
              if (blank >= 0) cut = blank + 1
            } else {
              for (let i = buf.queue.length - 1; i >= 0; i -= 1) {
                if (/[。！？；\n]/.test(buf.queue[i])) {
                  cut = i + 1
                  break
                }
              }
            }
          }
          // 切点落在引号中间时，这一块会只剩半个引文，被当成「没加引号」而误遮。
          // 把切点前移到开引号处，等引文闭合再判；一直不闭合就由「超长／跨空行」规则兜底。
          cut = quoteSafeCut(buf.queue, cut)
          if (cut <= 0) return
          let piece = buf.queue.slice(0, cut)
          buf.queue = buf.queue.slice(cut)
          // 句尾正好停在数字上（「桂枝 9」「桂枝９」）就先压着不发：单位「克」可能下一块才到，
          // 数字单独发出去以后，下一块只剩一个「克」，遮数就再也遮不住了。半角全角、两几数、余多许都认。
          if (!force) {
            const trimmed = piece.replace(/\s+$/, '')
            const dangling = /(?:(?:\d|[０-９])+(?:[.．](?:\d|[０-９])+)?|[两几数]?[一二三四五六七八九十百千半]+|[两几数])(?:余|多|许)?$/.exec(trimmed)
            if (dangling) {
              buf.queue = piece.slice(dangling.index) + buf.queue
              piece = trimmed.slice(0, dangling.index)
            }
          }
          if (piece === '') return
          // 只看这一段加上前文尾巴有没有剂量。tail 为空（回答开头）时也必须照判——
          // 早先写成 `tail === '' || !hasDosage(...)`，开头那句一律直接放行，
          // 第一句就是剂量句时永远拦不住。
          if (!hasDosage(buf.tail + piece)) {
            buf.tail = (buf.tail + piece).slice(-SCAN_WINDOW)
            yield* send(base, piece, kind)
            return
          }
          if (!isTcmSession()) {
            buf.tail = (buf.tail + piece).slice(-SCAN_WINDOW)
            yield* send(base, piece, kind)
            return
          }
          // 命中剂量：只把这一段「数字＋单位」遮成 *，药名和句子骨架照发
          const cleaned = blotDosage(piece, '*')
          if (cleaned !== piece) {
            ctx.logger?.warn?.('学理模式：回答中出现具体剂量，已把数值遮成 *')
            buf.tail = (buf.tail + cleaned).slice(-SCAN_WINDOW)
            yield* send(base, cleaned, kind)
            return
          }
          // 判成剂量但这一段本身没有可遮的数（数在前文尾巴里）：原样发，不整段抹掉
          ctx.logger?.warn?.('学理模式：本段剂量在前文，原样放行')
          buf.tail = (buf.tail + piece).slice(-SCAN_WINDOW)
          yield* send(base, piece, kind)
        }
        // block-end 带的是整块全文，宿主拿它当权威（First close wins）整体替换显示、落盘、回放、喂下轮。
        // 只遮 text-delta 增量没用：收束后全文一回显，克数又出来了。所以收块前把全文也遮一遍（文字与推理都遮）。
        const maskBlockEnd = (c) => {
          if (!c || c.type !== 'block-end' || !c.block || typeof c.block.text !== 'string') return c
          if (c.block.type !== 'text' && c.block.type !== 'reasoning') return c
          const cleaned = blotDosage(c.block.text, '*')
          if (cleaned === c.block.text) return c
          return { ...c, block: { ...c.block, text: cleaned } }
        }
        // 会话开头提醒资料库没设定：只在第一块正文前插一句，别的会话不碰。
        // 问诊闭麦的那一轮（hint.muted）也不插：那一轮说好一个字都不往外放，
        // 提醒也是字。拆分时这道闸曾丢过——sim 写了标记、这边没读，开局轮漏出整段提醒。
        let noticeSent = false
        // 一进来就认会话：不是中医会话的话，不进「攒句再判」的流水线，免得把别的对话的回答拖慢、拖断。
        // 两路分开判、各自兜住异常：会话识别失败不该把「提示词里带总纲」这一路也一起关掉。
        let isTcmNow = false
        try {
          isTcmNow = looksTcmPrompt(options?.system)
        } catch (error) {
          isTcmNow = false
        }
        if (!isTcmNow) {
          try {
            isTcmNow = looksTcmSession(ctx, options?.sessionId, name)
          } catch (error) {
            isTcmNow = false
          }
        }
        // 两版不许串：全量版会话里，学习版不加打赏区、不遮剂量、不念资料库提醒。
        // 认不出是哪一版就不动，宁可不管也不误伤。
        if (isTcmNow) {
          try {
            if (versionOf(ctx, options?.sessionId) === 'full') isTcmNow = false
          } catch (error) {
            // 判不出来就保持原判
          }
        }
        // 强制提问：这个会话还在收线索、这一轮又不是闭麦，就把闸门挂上。
        // 三种场面必须让开：模拟问诊局（口径归面板）、讲解答疑（问的是学问不是症状）、
        // 以及对方压根没在说自己难受（问「桂枝汤治什么」这种知识题，别拿问卷顶回去）。
        if (isTcmNow && !(hint && hint.muted) && !(hint && hint.clinic)) {
          try {
            const state = talkState(options?.sessionId)
            const recent = state.user.slice(-3).join(String.fromCharCode(10))
            const panel = /(讲解答疑|模拟问诊)/
            const symptom = /(疼|痛|胀|晕|眩|咳|喘|闷|烦|痒|麻|烧|吐|泻|秘|堵|不适|难受|累|乏|虚|失眠|睡不好|发热|发烧|怕冷|出汗|胃口|拉肚子|便秘|月经|头痛|头晕|肚子|胃|心慌|气短|肿|疹|鼻塞|流涕|咽|腰|肩|颈|腿|血压|口干|口苦|耳鸣)/
            const card = state.clue || panel.test(recent) || !symptom.test(recent) ? '' : forcedAskCard(recent)
            if (card !== '') gate = { card, mode: 'undecided', hold: '', index: undefined }
          } catch (error) {
            gate = null
          }
        }
        // 提醒真的发出去了，正文才整体往后挪一位（提醒占 0 号块）；没发提醒就一切照旧。
        let noticePushed = false
        const shift = (out) => (noticePushed && typeof out?.index === 'number' ? { ...out, index: out.index + 1 } : out)
        // 收尾（学习版这一层）：末尾那两行免责声明是硬性的，模型漏写由代码补；
        // 补上声明就算给了说法，打赏一并摆——同一个会话只摆一次，回答里已有打赏码的不再补第二块。
        let tailText = ''
        let maxIndex = -1
        let sawGift = false
        let sawTool = false
        let tailSent = false
        const note = (out) => {
          if (out && typeof out.index === 'number' && out.index > maxIndex) maxIndex = out.index
          return out
        }
        const sendTail = function* () {
          if (tailSent) return
          tailSent = true
          // 这一轮被换成问诊卡：提问轮没有正文，声明与打赏都不摆。
          if (gate && gate.mode === 'replace') return
          try {
            // 模拟问诊面板开的局：口径与打赏都归那边，这里一个字都不添。
            if (hint && hint.clinic) return
            // 闭麦轮不许插话：连声明与打赏也一起让开。
            if (hint && hint.muted) return
            // 不是中医会话：原样转发，一个字节都不添。
            if (!isTcmNow) return
            // 这一轮没写正文（例如只调工具），没有回答可收尾：不许凭空贴声明、摆打赏。
            if (tailText.trim() === '') return
            // 这一轮还调了工具：通常说明话没说完，收尾要等到真正写完那一轮。
            // 但模型已经把免责声明写在末尾时，这一轮就是收尾；不能因为调过检索工具
            // 把声明后面的打赏整段吞掉——用户看到的「有声明、没二维码」就是这么来的。
            if (sawTool && !hasGiftSign(tailText)) return
            // 末尾两行免责声明是硬性的：模型漏写就由代码补上，一行都不许少。
            const lack = missingDisclaimer(tailText)
            // 补上声明之后，这一份回答就算有了声明，打赏也照摆。
            const seen = tailText + lack.join('')
            const parts = []
            if (lack.length > 0) parts.push(lack.join('\n'))
            if (!sawGift && hasGiftSign(seen)) {
              // 一个会话只摆一次：同一局里再给说法、再讲一次，都不重复摆。
              const key = String(options?.sessionId || '')
              if (!(key && giftOnce.has(key))) {
                if (key) {
                  giftOnce.add(key)
                  while (giftOnce.size > 300) giftOnce.delete(giftOnce.values().next().value)
                }
                const gift = dashangBlock()
                if (gift) parts.push(gift)
              }
            }
            if (parts.length === 0) return
            const text = parts.join('\n\n')
            const index = maxIndex + 1
            yield note({ type: 'block-start', index, blockType: 'text' })
            yield note({ type: 'text-delta', index, text })
            yield note({ type: 'block-end', index, block: { type: 'text', text } })
          } catch (error) {
            ctx.logger?.warn?.('学理模式：收尾（声明／打赏）没加上（不影响回答）：%o', error)
          }
        }
        for await (const chunk of next()) {
          if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') continue
          // 不是中医会话：原样转发，一个字节都不动。
          if (!isTcmNow) {
            yield chunk
            continue
          }
          if (!noticeSent && !(hint && hint.muted) && chunk.type === 'block-start' && typeof chunk.index === 'number' && chunk.index >= 0) {
            noticeSent = true
            const notice = kbNotice(options?.sessionId, options?.system)
            // 提醒要单独占一块：宿主只认 block-start 登记块，直接把提醒塞进正文块会把它顶掉。
            // 所以先把正文那块开出来（挪到 1 号），再在前面补提醒那块（0 号，自己开、自己收）。
            if (typeof notice === 'string' && notice !== '') {
              noticePushed = true
              yield { ...chunk, index: NOTICE_BLOCK + 1 }
              yield { type: 'block-start', index: NOTICE_BLOCK, blockType: 'text' }
              yield { type: 'text-delta', index: NOTICE_BLOCK, text: notice }
              yield { type: 'block-end', index: NOTICE_BLOCK, block: { type: 'text', text: notice } }
              continue
            }
          }
          if (isToolChunk(chunk)) sawTool = true
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            lastChunk = chunk
            bufs.text.queue += chunk.text
            // 判打赏只看尾巴：那两句声明在回答最末尾，记着最后四百字就够。
            tailText = (tailText + chunk.text).slice(-400)
            if (chunk.text.includes('dashang-qr.png')) sawGift = true
            // take 已经返回对象，原样发；不能再套一层，套了 text 就成了对象，宿主报 text-delta text must be a string
            for (const out of take(false, chunk, bufs.text, 'text')) yield note(shift(out))
            continue
          }
          // 推理通道（思考过程）同样会带克数，走同一套遮罩；只是不进打赏尾巴、不认打赏码。
          if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            lastReasoning = chunk
            bufs.reasoning.queue += chunk.text
            for (const out of take(false, chunk, bufs.reasoning, 'reasoning')) yield note(shift(out))
            continue
          }
          if (chunk.type === 'finish' || chunk.type === 'block-end' || chunk.type === 'usage') {
            // 正文还压着，先把剩下的吐完，再放结束块；文字与推理两条通道都要吐干净。
            for (const out of take(true, lastChunk || chunk, bufs.text, 'text')) {
              yield note(shift(out))
              // 正文还没发出去的那段，index 要跟着块一起挪；否则收块时找不到自己开的块。
              if (out?.index === lastChunk?.index) lastChunk = shift(out)
            }
            for (const out of take(true, lastReasoning || chunk, bufs.reasoning, 'reasoning')) {
              yield note(shift(out))
              if (out?.index === lastReasoning?.index) lastReasoning = shift(out)
            }
          }
          // 回答里已经写过打赏码的（比如别处补过），这里就不再补第二块。
          if (chunk.type === 'finish') yield* sendTail()
          // text-delta 上面已经 continue 过，这里只剩收尾类与被挪过块号的块。
          // 收块全文先遮一遍再发（S1）：宿主按 block-end 全文整体替换显示与落盘，不遮就等于没遮。
          let out = maskBlockEnd(chunk)
          // 换成问诊卡：宿主按 block-end 的全文整体替换显示与落盘，换在这里才算数。
          if (gate && gate.mode === 'replace' && out && out.type === 'block-end' && out.block
            && out.block.type === 'text' && typeof out.index === 'number'
            && (typeof gate.index !== 'number' || out.index === gate.index)) {
            out = { ...out, block: { ...out.block, text: gate.card } }
          }
          if (noticeSent && typeof out.index === 'number') yield note(shift(out))
          else yield note(out)
        }
        // 宿主偶尔不给 finish：流结束前再兜一次，免得整块漏掉。
        yield* sendTail()
  }

  /* ── 2.5 资料查询页：开一条只读通道，回原文＋白话 ── */
  try {
    const mountSearch = (scoped) => {
      Promise.resolve()
        .then(() => mountSearchRoute(scoped, {
          path: '/dsh-tcm-xueli/search',
          log: '学理模式：',
          rootDir: () => currentPath(config),
        }))
        .then((dispose) => {
          if (typeof scoped.effect === 'function') {
            try { scoped.effect(() => () => { if (typeof dispose === 'function') dispose() }) } catch { /* 没有 effect 就靠进程退出回收 */ }
          }
        })
        .catch((error) => {
          ctx.logger?.warn?.('学理模式：资料查询通道没开（不影响会话）：%o', error)
        })
      /* 穴位图：同一个面板里点名字就能看图，通道独立，坏了只少一张图。 */
      Promise.resolve()
        .then(() => mountAcupointRoute(scoped, {
          path: '/dsh-tcm-xueli/acupoint/',
          log: '学理模式：',
        }))
        .then((dispose) => {
          if (typeof scoped.effect === 'function') {
            try { scoped.effect(() => () => { if (typeof dispose === 'function') dispose() }) } catch { /* 没有 effect 就靠进程退出回收 */ }
          }
        })
        .catch((error) => {
          ctx.logger?.warn?.('学理模式：穴位图通道没开（不影响会话）：%o', error)
        })
      /* 面板插图：讲解答疑头上的老先生小像，通道独立，坏了只是小像不显示。 */
      Promise.resolve()
        .then(() => mountArtRoute(scoped, {
          path: '/dsh-tcm-xueli/img/',
          log: '学理模式：',
        }))
        .then((dispose) => {
          if (typeof scoped.effect === 'function') {
            try { scoped.effect(() => () => { if (typeof dispose === 'function') dispose() }) } catch { /* 没有 effect 就靠进程退出回收 */ }
          }
        })
        .catch((error) => {
          ctx.logger?.warn?.('学理模式：面板插图通道没开（不影响会话）：%o', error)
        })
      /* 答疑的删除通道：宿主只给归档不给删，真删走这条，只认标题以「答疑·」开头的本机局。 */
      Promise.resolve()
        .then(() => mountTeachRoute(scoped, { log: '学理模式：' }))
        .then((dispose) => {
          if (typeof scoped.effect === 'function') {
            try { scoped.effect(() => () => { if (typeof dispose === 'function') dispose() }) } catch { /* 没有 effect 就靠进程退出回收 */ }
          }
        })
        .catch((error) => {
          ctx.logger?.warn?.('学理模式：答疑删除通道没开（不影响会话）：%o', error)
        })
      /* 医案浏览：工作台「添加医案」按钮背后只读列出/读取资料库 医案/ 的 .md，通道独立，坏了只是 browse 不了。 */
      Promise.resolve()
        .then(() => mountYianRoute(scoped, {
          path: '/dsh-tcm-xueli/yian',
          log: '学理模式：',
          rootDir: () => currentPath(config),
        }))
        .then((dispose) => {
          if (typeof scoped.effect === 'function') {
            try { scoped.effect(() => () => { if (typeof dispose === 'function') dispose() }) } catch { /* 没有 effect 就靠进程退出回收 */ }
          }
        })
        .catch((error) => {
          ctx.logger?.warn?.('学理模式：医案浏览通道没开（不影响会话）：%o', error)
        })
    }
    /* Web 服务可能比本插件晚就位：有 inject 就等它，没有就直接挂。 */
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], mountSearch)
    } else {
      mountSearch(ctx)
    }
  } catch (error) {
    ctx.logger?.warn?.('学理模式：资料查询装载失败（不影响会话）：%o', error)
  }

  /* ── 3. 启动后建索引、挂监视 ── */
  try {
    const startup = setTimeout(() => {
      state.startup = null
      sync(state, ctx, config, 'startup')
    }, STARTUP_DELAY)
    if (startup.unref) startup.unref()
    // 先按「监视未挂上」的短间隔起步，sync 里挂好监视后会自动放慢到 15 秒。
    retunePoll(state, ctx, config)
  } catch (error) {
    ctx.logger?.warn?.('学理模式：索引自动生成初始化失败（不影响会话）：%o', error)
  }

  return { stream }
}
