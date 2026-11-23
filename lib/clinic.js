/**
 * 中医 · 经方（学习版）· 模拟问诊的「病例卡」
 *
 * 从「中医岐黄」工作台并过来的几件事，现在归学习版自己管：
 * - xueli_draw_anchor：开局抽锚点（六经＋病机＋诱因），只走工具结果，不给医生看；
 * - xueli_begin_round：开局定病例，把题面记进本次运行的记录；
 * - xueli_finish_round：医生交卷、判完之后记结论；
 * - xueli_list_rounds：翻本次运行里的记录。
 *
 * 为什么改名加前缀：岐黄工作台若还装着，它那三个同名工具会撞车。
 * 底牌不写进给医生或病人的任何消息；题面与成绩会存进资料库的医案目录（有库根锁），重启后还翻得到。
 *
 * 任何一步失败都只记日志，绝不向上抛：问诊是主功能，记录是附加功能。
 */
import { versionOf } from './guard.js'
import { blotDosage } from './dosage-guard.js'

const LOG = '[学理模式·问诊] '
export const TOOL_NAMES = ['xueli_draw_anchor', 'xueli_begin_round', 'xueli_finish_round', 'xueli_list_rounds']

/** 记录条数上限：只留最近的，避免常驻进程里越攒越多。 */
const MAX_ROUNDS = 200
/** 每判完多少局，在裁判点评末尾摆一次打赏码。 */
export const GIFT_EVERY = 10

/* 每局随机锚点：六经＋病机一对＋诱因。只走工具结果，不进任何医生可见的消息。 */
const ANCHOR_LIUJING = ['太阳', '阳明', '少阳', '太阴', '少阴', '厥阴']
const ANCHOR_YOUYIN = ['受凉', '饮食不节', '劳累过度', '情志不遂', '误服过不对症的方', '久病体弱', '熬夜']
const ANCHOR_BINGJI = {
  '简单': ['寒证', '热证', '虚证', '实证'],
  '普通': ['表里同病', '气机不畅', '水饮内停', '湿热内蕴', '痰湿中阻', '食积'],
  '困难': ['寒热错杂', '虚实夹杂', '津液受伤', '血瘀', '上热下寒', '真寒假热'],
}
/** 锚点只记最近八局，抽过的不再抽。 */
const ANCHOR_MEMORY = 8

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)]
}

/** 抽一对病机：第二抽从去掉第一抽的池里拿，不会出「寒证＋寒证」。 */
function pickBingjiPair(pool) {
  const a = pickOne(pool)
  const rest = pool.filter((one) => one !== a)
  return [a, rest.length ? pickOne(rest) : a]
}

function textOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

function linesOf(value) {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v).trim()).filter(Boolean).slice(0, 40)
}

/**
 * 最简记录库：进程内存里一份，另通过 loadRounds/saveRound 落到资料库的「最近几局.jsonl」。
 * 例外是抽过的锚点：它要跨重启记得住，否则重启后第一局就可能撞上天的病；
 * 由外面传读写函数进来（存在插件私有目录里，不进资料库——医生会话的文件工具读不到），
 * 读写失败记日志并如实回报，绝不影响抽题。
 */
export function createStore(options = {}) {
  const memory = new Map()
  const loadSeen = typeof options.loadSeen === 'function' ? options.loadSeen : () => []
  const saveSeen = typeof options.saveSeen === 'function' ? options.saveSeen : null
  const loadRounds = typeof options.loadRounds === 'function' ? options.loadRounds : () => []
  const saveRound = typeof options.saveRound === 'function' ? options.saveRound : null
  const loadProgress = typeof options.loadProgress === 'function' ? options.loadProgress : () => ({})
  const saveProgress = typeof options.saveProgress === 'function' ? options.saveProgress : null
  const logger = options.logger || null
  /** 写入失败不静默：记一条日志，调用方还能从返回值知道没存上。 */
  function logWarn(msg, error) {
    try {
      logger?.warn?.(LOG + msg + (error ? '：' + String(error?.message || error) : ''))
    } catch (inner) { /* 日志也坏了就只剩返回值 */ }
  }
  /** 已判完的局数、上次摆过打赏的那一档：每满十局摆一次收款码。 */
  let roundsDone = 0
  let giftAt = 0
  try {
    const saved = loadProgress()
    if (saved && typeof saved === 'object') {
      roundsDone = Math.max(0, Math.floor(Number(saved.total) || 0))
      giftAt = Math.max(0, Math.floor(Number(saved.giftAt) || 0))
    }
  } catch (error) {
    // 读不到就从零数
  }
  /** 这一局判完就该摆打赏的会话（判完那一刻发出口，那一刻才算数）。 */
  const giftDue = new Set()
  /** 已经摆过打赏的会话：入口那一层可能多叫几次，只摆一次。 */
  const giftShown = new Set()

  function keepProgress() {
    if (!saveProgress) return
    try {
      const ok = saveProgress({ total: roundsDone, giftAt })
      if (ok === false) logWarn('打赏计数落盘失败（重启后计数可能不准）')
    } catch (error) {
      logWarn('打赏计数落盘失败（重启后计数可能不准）', error)
    }
  }
  /** 上次抽到的锚点按会话存：两个医生会话同时开局，各用各的底牌，绝不串锚。
   *  begin 取走即清：一局只配一张底牌，没再抽就开下一局时不再沿用上一局的。 */
  const lastAnchorOf = new Map()
  /** 最近抽过的锚点（八局内不重复）。开局先向外面要一次，保证重启后也认得出。 */
  const anchorHistory = []
  try {
    const saved = loadSeen()
    if (Array.isArray(saved)) anchorHistory.push(...saved.filter((one) => typeof one === 'string').slice(-ANCHOR_MEMORY))
  } catch (error) {
    // 读不到就算了
  }

  // 最近几局从盘上读回来：重启后 xueli_list_rounds 照样翻得到上几局出过什么病。
  try {
    const rows = loadRounds()
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const id = textOf(row.id).trim()
        if (!id) continue
        memory.set(id, {
          id,
          createdAt: Number(row.createdAt) || 0,
          level: textOf(row.level),
          direction: textOf(row.direction),
          caseSummary: textOf(row.caseSummary),
          verdict: textOf(row.verdict),
          failLine: textOf(row.failLine),
          prescribe: textOf(row.prescribe),
          anchor: textOf(row.anchor),
          finishedAt: Number(row.finishedAt) || 0,
        })
      }
      while (memory.size > MAX_ROUNDS) {
        const oldest = memory.keys().next()
        if (oldest.done) break
        memory.delete(oldest.value)
      }
    }
  } catch (error) {
    // 读不到就当没有记录
  }

  /** 落盘结果如实回报：true 存上了，false 没存上（已记日志）。没接落盘函数按内存模式算成功。 */
  async function keepRow(row) {
    if (!saveRound || !row) return true
    try {
      const ok = await saveRound(row)
      if (ok === false) {
        logWarn('这一局落盘失败（重启后可能翻不到）')
        return false
      }
      return true
    } catch (error) {
      logWarn('这一局落盘失败（重启后可能翻不到）', error)
      return false
    }
  }

  function rememberAnchor(one) {
    anchorHistory.push(one)
    while (anchorHistory.length > ANCHOR_MEMORY) anchorHistory.shift()
    if (!saveSeen) return
    try {
      const ok = saveSeen(anchorHistory.slice())
      if (ok === false) logWarn('锚点历史落盘失败（下一局避重可能不准）')
    } catch (error) {
      logWarn('锚点历史落盘失败（下一局避重可能不准）', error)
    }
  }

  /** 现抽一条锚点：难度决定病机池；抽过的八局内不再抽。
   *  非法难度明确报错（工具层 enum 已挡，store 不再静默回落）；
   *  抽到的底牌按会话挂好，等本会话的 begin 来取。 */
  function drawAnchor(level, sessionId) {
    const key = String(level || '').trim()
    const pool = ANCHOR_BINGJI[key]
    if (!pool) throw new Error('难度只能是「简单／普通／困难」，收到的是「' + key + '」')
    let picked = ''
    for (let i = 0; i < 60; i += 1) {
      const pair = pickBingjiPair(pool)
      const one = [pickOne(ANCHOR_LIUJING), pair[0], pair[1], pickOne(ANCHOR_YOUYIN)].join('|')
      if (!anchorHistory.includes(one)) { picked = one; break }
    }
    if (picked === '') {
      const pair = pickBingjiPair(pool)
      picked = [pickOne(ANCHOR_LIUJING), pair[0], pair[1], pickOne(ANCHOR_YOUYIN)].join('|')
    }
    rememberAnchor(picked)
    const owner = textOf(sessionId)
    lastAnchorOf.set(owner, picked)
    while (lastAnchorOf.size > MAX_ROUNDS) {
      const oldest = lastAnchorOf.keys().next()
      if (oldest.done) break
      lastAnchorOf.delete(oldest.value)
    }
    const [liujing, bingjiA, bingjiB, youyin] = picked.split('|')
    return {
      anchor: picked,
      line: `起手经络：${liujing}；病机：${bingjiA}＋${bingjiB}；诱因：${youyin}`,
    }
  }

  function snapshot() {
    // 同一毫秒开的两局 createdAt 会一样：用 Map 的插入次序兜底，后开的排前面。
    let order = 0
    const rows = []
    for (const row of memory.values()) rows.push({ row, order: order++ })
    rows.sort((a, b) => (b.row.createdAt || 0) - (a.row.createdAt || 0) || b.order - a.order)
    return rows.map((item) => item.row)
  }

  async function begin(input) {
    const id = textOf(input.id).trim()
    if (!id) return null
    const doctorId = textOf(input.doctorId)
    // 只认本会话抽的底牌，取走即清；别的会话抽的不许拿过来。
    const anchor = lastAnchorOf.get(doctorId) || ''
    lastAnchorOf.delete(doctorId)
    // 同一局号重开：整条换新，绝不把上一局的结论带过来。
    const row = {
      id,
      createdAt: Date.now(),
      level: textOf(input.level),
      direction: textOf(input.direction),
      caseSummary: textOf(input.caseSummary),
      anchor,
      patientId: textOf(input.patientId),
      doctorId,
    }
    memory.set(id, row)
    const persisted = await keepRow(row)
    while (memory.size > MAX_ROUNDS) {
      const oldest = memory.keys().next()
      if (oldest.done) break
      memory.delete(oldest.value)
    }
    return { ...row, persisted }
  }

  async function end(input) {
    const id = textOf(input.id).trim()
    if (!id) return null
    // 没开过的局不能判：先有 begin 才有 end，免得凭空多出一条没题面的成绩。
    const row = memory.get(id)
    if (!row) return null
    // 已判过的局拒绝覆盖：结论定了就是定了，要重判请开新局。
    if (Number(row.finishedAt) > 0) return { ...row, alreadyFinished: true }
    const doctorId = textOf(input.doctorId) || textOf(row.doctorId)
    Object.assign(row, {
      doctorId,
      verdict: textOf(input.verdict),
      failLine: textOf(input.failLine),
      failPoints: linesOf(input.failPoints),
      mustAsk: linesOf(input.mustAsk),
      prescribe: textOf(input.prescribe),
      finishedAt: Date.now(),
    })
    memory.set(id, row)
    const persisted = await keepRow(row)
    // 打赏按「判完的局数」数：同一局重判不重复数（上面已拒），满十局摆一次。
    // 标记按医生会话号（不是局号）：出口层拿会话号来问，才问得到。
    roundsDone += 1
    if (GIFT_EVERY > 0 && roundsDone % GIFT_EVERY === 0) {
      giftAt = roundsDone
      if (doctorId) giftDue.add(doctorId)
    }
    keepProgress()
    return { ...row, persisted }
  }

  /** 看一眼这一会话有没有待摆的打赏（不认领）：出口层据此决定走不走打赏那一段。 */
  function hasGift(sessionId) {
    const key = textOf(sessionId).trim()
    return Boolean(key) && giftDue.has(key)
  }

  /** 这一局判完的当下要不要在点评末尾摆打赏；问一次就算认领，别处再问一律没有了。 */
  function takeGift(sessionId) {
    const key = textOf(sessionId).trim()
    if (!key || !giftDue.has(key)) return null
    giftDue.delete(key)
    const current = roundsDone > 0 && roundsDone % GIFT_EVERY === 0 ? roundsDone : giftAt
    if (!current) return null
    // 按「会话＋档位」去重：同一档多叫几次只摆一次，下一档（又一个十局）照常摆。
    const shownKey = key + '@' + current
    if (giftShown.has(shownKey)) return null
    giftShown.add(shownKey)
    while (giftShown.size > 64) giftShown.delete(giftShown.values().next().value)
    return { rounds: current }
  }

  async function list(limit) {
    const n = Math.max(1, Math.min(50, Number(limit) || 10))
    return snapshot().slice(0, n)
  }

  /** 从磁盘再读一次（用户可能在别处删了记录文件）：只补，不覆盖现有记忆。 */
  function reloadSeen() {
    try {
      const saved = loadSeen()
      if (!Array.isArray(saved)) return
      for (const one of saved) {
        if (typeof one === 'string' && !anchorHistory.includes(one)) anchorHistory.push(one)
      }
      while (anchorHistory.length > ANCHOR_MEMORY) anchorHistory.shift()
    } catch (error) {
      // 读不到就算了
    }
  }

  /** 开局前先看一眼最近几局用过的锚点，避免撞上天的病。 */
  function noteSeen(list) {
    if (!Array.isArray(list)) return
    for (const one of list) {
      if (typeof one === 'string' && one && !anchorHistory.includes(one)) anchorHistory.push(one)
    }
    while (anchorHistory.length > ANCHOR_MEMORY) anchorHistory.shift()
    if (saveSeen) {
      try {
        const ok = saveSeen(anchorHistory.slice())
        if (ok === false) logWarn('锚点历史落盘失败（下一局避重可能不准）')
      } catch (error) {
        logWarn('锚点历史落盘失败（下一局避重可能不准）', error)
      }
    }
  }

  return { begin, end, list, snapshot, drawAnchor, reloadSeen, noteSeen, hasGift, takeGift }
}

function pick(description, values) {
  return { type: 'string', description, enum: values.slice() }
}

function str(description) { return { type: 'string', description } }
function arr(description) { return { type: 'array', description, items: { type: 'string' } } }
function num(description) { return { type: 'number', description } }

/** 原生 JSON Schema：工具参数（必须显式 additionalProperties）。 */
function objectSchema(properties, required) {
  return { type: 'object', properties, required: required || [], additionalProperties: false }
}

/** 工具返回值：结构固定，多出来的字段也允许（render 只取用得到的两三样）。 */
const OUT = { type: 'object', additionalProperties: true }

/** 注册四个工具；宿主没有工具服务时安静退场，不拖垮插件。 */
export async function registerClinicTools(ctx, store) {
  const tools = ctx.get ? ctx.get('tools') : undefined
  if (!tools || typeof tools.register !== 'function') {
    ctx.logger?.warn?.(LOG + '宿主没有工具服务，问诊记录工具没装（不影响聊天）')
    return () => {}
  }
  const disposers = []
  // 两版工具不许串：全量版会话里这三个工具一律不出现（挂在注册条件上，不是执行时再拦）。
  const onlyXueli = {
    when: (context) => {
      try {
        return versionOf(ctx, context?.agent) !== 'full'
      } catch (error) {
        // 判不出来就照常挂：拦错会把主功能关掉，这里宁可少管。
        return true
      }
    },
  }
  const ok = (text) => [{ type: 'text', text }]
  const warn = (msg, error) => {
    ctx.logger?.warn?.(LOG + msg + '：' + String(error && error.message ? error.message : error))
  }

  disposers.push(tools.register({
    name: 'xueli_draw_anchor',
    description: '【模拟问诊·抽题】开局第一步先调这个：插件现抽本局锚点（六经＋一对病机＋诱因），病例只围着它编。锚点是出题底牌，不许出现在给医生看的任何文字里。',
    parameters: objectSchema({
      level: pick('难度，只能填这三个之一。', ['简单', '普通', '困难']),
    }, ['level']),
    output: {
      schema: OUT,
      // 人类可见的渲染只给中性文案：message 里的【本局锚点】是出题底牌，
      // 只给主持人（模型）判卷用，绝不能摆进界面。
      render: () => ok('已抽题，底牌保密。请派病人开局。'),
    },
    async execute(args, exec) {
      let drawn
      try {
        drawn = store.drawAnchor(args?.level, textOf(exec?.agent?.id))
      } catch (error) {
        warn('抽题失败', error)
        return {
          ok: false,
          message: '抽题没成：' + String(error?.message || error)
            + '。按协议可自抽一条经络、两种病机、一个诱因代用，同样避开最近几局，底牌同样不露。',
        }
      }
      return {
        ok: true,
        anchor: drawn.anchor,
        message: '【本局锚点】' + drawn.line
          + '。照这个锚点现编病例：主症、舌象脉象、起病经过都围着它转；锚点以外的六经病机一律不用。这一行是出题底牌，不许写进医生可见的任何文字，也不许进病人台词。',
      }
    },
  }, onlyXueli))

  disposers.push(tools.register({
    name: 'xueli_begin_round',
    description: '【模拟问诊·开局】造好病例、派出病人之后调用一次，把这一局的题面记下（只记一句话题面，不记病例细节）。',
    parameters: objectSchema({
      id: str('本局编号，如 20261119-1。'),
      level: pick('难度，只能填这三个之一。', ['简单', '普通', '困难']),
      direction: pick('方向，只能填这三个之一。', ['方药', '针灸', '针药']),
      case_summary: str('病例一句话（不含底牌细节）：如「男 45 岁，胃脘痞满」。'),
      patient_session_id: str('演病人的子代理名字（派病人时返回的那个名字）。'),
      doctor_session_id: str('医生会话（本局问诊所在会话）的 id，不填就取当前会话。'),
    }, ['id', 'level', 'direction']),
    output: { schema: OUT, render: (_args, value) => ok(textOf(value && value.message)) },
    async execute(args, exec) {
      const doctor = textOf(args.doctor_session_id) || textOf(exec?.agent?.id)
      const row = await store.begin({
        id: textOf(args.id),
        level: textOf(args.level),
        direction: textOf(args.direction),
        caseSummary: blotDosage(textOf(args.case_summary)),
        patientId: textOf(args.patient_session_id),
        doctorId: doctor,
      }).catch((error) => {
        warn('开局记录失败', error)
        return null
      })
      let message
      if (!row) {
        message = '题面没记上（资料库还没设，或写不进去）；不影响问诊，继续。'
      } else if (row.persisted === false) {
        message = '这一局的题面已记下（只在本次运行里）；注意：落盘失败，重启后可能翻不到。'
      } else {
        message = '这一局的题面已记下（存进资料库的医案里，重启后翻得到）。'
      }
      if (row && !row.anchor) {
        message += '（提示：本局没有抽题记录；若抽题工具调不动，按协议自抽代用即可，底牌同样不露。）'
      }
      return { ok: Boolean(row), id: textOf(args.id), message }
    },
  }, onlyXueli))

  disposers.push(tools.register({
    name: 'xueli_finish_round',
    description: '【模拟问诊·交卷】医生交卷、你判完之后调用一次，把结论记下（存进资料库的医案里，重启后还翻得到）。',
    parameters: objectSchema({
      id: str('本局编号。'),
      verdict: pick('结论，只能填这三个之一。', ['过关', '边缘', '不过关']),
      fail_line: str('一句话说为什么。'),
      fail_points: arr('硬错逐条（每条一句话）。'),
      must_ask: arr('医生漏问的关键问题。'),
      prescribe: str('医生本局给出的方药或取穴（只写药名／穴位名，不写克数）。'),
    }, ['id', 'verdict']),
    output: { schema: OUT, render: (_args, value) => ok(textOf(value && value.message)) },
    async execute(args, exec) {
      const doctor = textOf(exec?.agent?.id)
      const row = await store.end({
        id: textOf(args.id),
        doctorId: doctor,
        verdict: textOf(args.verdict),
        failLine: blotDosage(textOf(args.fail_line)),
        failPoints: linesOf(args.fail_points).map((one) => blotDosage(one)),
        mustAsk: linesOf(args.must_ask).map((one) => blotDosage(one)),
        prescribe: blotDosage(textOf(args.prescribe)),
      }).catch((error) => {
        warn('成绩记录失败', error)
        return null
      })
      if (!row) {
        return {
          ok: false,
          id: textOf(args.id),
          message: '这一局没有开局记录（局号不对，或还没调 xueli_begin_round），成绩没记；请先开局再判。',
        }
      }
      if (row.alreadyFinished) {
        return {
          ok: false,
          id: textOf(args.id),
          message: '这一局已经判过了，结论不再覆盖；要重判请开新局。',
        }
      }
      return {
        ok: true,
        id: textOf(args.id),
        message: row.persisted === false
          ? '本局已判；注意：落盘失败，重启后可能翻不到。'
          : '这一局的成绩已记下（存进资料库的医案里）。',
      }
    },
  }, onlyXueli))

  disposers.push(tools.register({
    name: 'xueli_list_rounds',
    description: '【模拟问诊】翻最近几局的问诊记录：题面、方名或穴位名、结论都在，只是不带克数。会存进资料库，重启后也还在。开局前先看一遍，病机、主方、主症组合跟哪一局撞了，就换一个。',
    parameters: objectSchema({ limit: num('列几条，默认 10。') }),
    output: { schema: OUT, render: (_args, value) => ok(textOf(value && value.text)) },
    async execute(args) {
      const rows = await store.list(args.limit)
      const text = rows.length
        ? rows.map((r) => [
          new Date(r.createdAt).toLocaleString('zh-CN'),
          (r.level || '') + '·' + (r.direction || ''),
          r.caseSummary ? '题面 ' + blotDosage(String(r.caseSummary)) : '',
          r.prescribe ? '方 ' + blotDosage(String(r.prescribe)) : '',
          r.verdict || '（未交卷）',
          r.failLine ? blotDosage(String(r.failLine)) : '',
        ].filter(Boolean).join('　')).join('\n')
        : '最近还没有记录（这是头一局，或者资料库目录还没设）。'
      return { count: rows.length, text }
    },
  }, onlyXueli))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 已经卸载 */ }
    }
  }
}