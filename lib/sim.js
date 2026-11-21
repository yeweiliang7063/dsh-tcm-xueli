/**
 * 模拟问诊这一块的全部代码
 *
 * 只管问诊的事，跟经方学习版（提示词、剂量遮挡、资料库）没有任何来往：
 * - 思考开关：面板开出来的局把档位降到最低，交卷给回裁判，弃局/重启都还回去；
 * - 病例卡：开局、交卷、翻记录、抽锚点四件工具，记录落资料库「医案」目录；
 * - 闭麦：问诊期间的「子智能体已完成」这类通知回合，正文一个字都不往外放；
 * - 打赏：每判完十局，在裁判点评那一份回答末尾摆一次收款码。
 *
 * 这里任何一处出错都只记日志，学习版照常工作（见 lib/xuexi.js）。
 */
import { dashangBlock, mountDashangRoute } from './dashang.js'
import { createStore, registerClinicTools } from './clinic.js'
import { createSimThinker, mountSimEndRoute } from './sim-think.js'
import {
  appendSeenAnchor,
  dropGearEntry,
  readGearState,
  readRecentRounds,
  readRoundProgress,
  readSeenAnchors,
  saveGearEntry,
  saveRecentRound,
  saveRoundProgress,
} from './records.js'

/**
 * 打赏区由代码追加：模拟问诊每判完十局，在裁判点评那一份回答的末尾摆一次；
 * 其余对话一律不摆。模型那边一个字都不写打赏。
 * 网址必须带实时端口——宿主只认绝对 http(s) 网址，相对路径一律显示「图片无法预览」。
 */
function dashangGiftText(rounds, scope) {
  try {
    const nth = Number(rounds)
    if (!Number.isFinite(nth) || nth <= 0) return ''
    let server
    try {
      server = scope && typeof scope.get === 'function' ? scope.get('webServer') : undefined
    } catch {
      server = undefined
    }
    return dashangBlock(server, nth)
  } catch {
    return ''
  }
}

/**
 * 装上模拟问诊：思考开关、病例卡工具、弃局通道、打赏通道。
 * 返回的 stream 是出口那一层要用的：闭麦＋点评末尾补打赏。
 * 拿不到服务就什么都不做，返回的 stream 原样放行。
 */
export function applySim(ctx, config, api) {
  const currentPath = api.currentPath

  // 计满十局的那一局，只有病例卡认领得到；认领一次就清掉。
  let clinicGiftOf = null
  const gifted = { due: null }
  // 闭嘴与弃局还原都跟着开关实例走：实例没装好就一律不动，热重载也不背旧包袱。
  const muted = { of: null }
  const simEnd = { release: null }

  // 思考开关：只管「模拟问诊」面板开出来的局（开局指令带局号）。
  // 开局与病人子会话调到最低，点「交卷」再给回裁判；面板弃局时经 sim-end 通道当场还回去；
  // 重启/热重载后靠资料库里的档位存根还回去。别的会话手打开局只走协议，不碰档位。
  // 只改这一局会话的运行时档位，不写全局默认；拿不到服务就什么都不做。
  try {
    if (typeof ctx.on === 'function' && typeof ctx.effect === 'function') {
      const { thinker, child, settled, giftDue, quietOf, release } = createSimThinker(ctx, {
        versionOf: api.versionOf,
        giftOf: () => gifted.due,
        // 档位存根落在资料库「医案」目录下；路径每次现取，用户改了设置也跟得上。
        gearLoad: () => readGearState(currentPath(config)),
        gearSave: (id, restore) => saveGearEntry(currentPath(config), id, restore),
        gearDrop: (id) => dropGearEntry(currentPath(config), id),
      })
      gifted.due = giftDue
      muted.of = quietOf
      simEnd.release = release
      ctx.effect(() => ctx.on('session/event', (session, event) => {
        thinker(session, event)
        child(session, event)
        settled(session, event)
      }))
      // 弃局通道：面板换局/返回时通知这里把档位还回去（只认本机页面）。
      const mountSimEnd = (scoped) => {
        Promise.resolve()
          .then(() => mountSimEndRoute(scoped || ctx, {
            release: (id) => { if (typeof simEnd.release === 'function') simEnd.release(id) },
            log: '学理模式：',
          }))
          .then((dispose) => {
            if (typeof scoped?.effect === 'function') {
              try { scoped.effect(() => () => { if (typeof dispose === 'function') dispose() }) } catch { /* 没有 effect 就靠进程退出回收 */ }
            }
          })
          .catch((error) => {
            ctx.logger?.warn?.('学理模式：弃局通道没开（重启后靠存根还档位）：%o', error)
          })
      }
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], mountSimEnd)
      } else {
        mountSimEnd(ctx)
      }
    }
  } catch (error) {
    ctx.logger?.warn?.('学理模式：思考开关注册失败（不影响问诊）：%o', error)
  }

  /* ── 打赏码：回答结尾两张收款码，同源发图 ── */
  try {
    const mountDashang = (scoped) => {
      Promise.resolve()
        .then(() => mountDashangRoute(scoped || ctx))
        .then((dispose) => {
          if (typeof scoped?.effect === 'function') {
            try { scoped.effect(() => () => { if (typeof dispose === 'function') dispose() }) } catch { /* 没有 effect 就靠进程退出回收 */ }
          }
        })
        .catch((error) => {
          ctx.logger?.warn?.('学理模式：打赏码通道没开（不影响会话）：%o', error)
        })
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], mountDashang)
    } else {
      mountDashang(ctx)
    }
  } catch (error) {
    ctx.logger?.warn?.('学理模式：打赏码装载失败（不影响会话）：%o', error)
  }

  /* ── 模拟问诊：病例卡与成绩记录（从岐黄工作台并过来，工具改名防撞） ── */
  try {
    const clinicStore = createStore({
      // 满十局的计数落在资料库里，重启、重装都接着数。
      loadProgress: () => readRoundProgress(currentPath(config)),
      saveProgress: (progress) => saveRoundProgress(currentPath(config), progress),
      // 抽过的锚点跨重启记得住：存在资料库「医案」目录下的一个小文件里。
      // 路径每次现取，用户改了设置也跟得上；读不到、写不进都不影响出题。
      loadSeen: () => readSeenAnchors(currentPath(config)),
      saveSeen: (list) => {
        const last = Array.isArray(list) ? list[list.length - 1] : ''
        if (!last) return false
        return appendSeenAnchor(currentPath(config), last)
      },
      // 最近几局也落一份：重启后 xueli_list_rounds 照样翻得到上几局出过什么病。
      loadRounds: () => readRecentRounds(currentPath(config)),
      saveRound: (row) => saveRecentRound(currentPath(config), row),
    })
    clinicGiftOf = (sessionId) => clinicStore.takeGift(sessionId)
    const mountClinic = (scoped) => {
      const owner = scoped || ctx
      Promise.resolve()
        .then(() => registerClinicTools(owner, clinicStore))
        .then((release) => {
          if (typeof release !== 'function') return
          // 插件可能在注册回来之前就被卸载：这时 effect 已经不能用了，立刻自行释放。
          if (owner.disposed || typeof owner.effect !== 'function') {
            release()
            return
          }
          try { owner.effect(() => () => { release() }) } catch { release() }
        })
        .catch((error) => {
          ctx.logger?.warn?.('学理模式：问诊记录工具没装（不影响聊天）：' + String(error && error.message ? error.message : error))
        })
    }
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], mountClinic)
    } else {
      mountClinic(ctx)
    }
  } catch (error) {
    ctx.logger?.warn?.('学理模式：模拟问诊装载失败（不影响会话）：%o', error)
  }

  /* ── 出口那一层：闭麦与点评末尾补打赏 ── */
  // 只动问诊自己的事：被通知叫醒的回合清空文字，满十局的那份点评末尾补一块收款码。
  // 剂量遮挡、资料库提醒归学习版管（见 lib/xuexi.js），这里一个字都不碰。
  const stream = async function* (options, next, hint) {
    let simMute = false
    try {
      simMute = typeof muted.of === 'function' && !!muted.of(options?.sessionId)
    } catch (error) {
      simMute = false
    }
    // 学习版靠这一位决定要不要插资料库提醒：闭麦的回合本来就不该念提醒。
    if (hint && typeof hint === 'object') hint.muted = simMute
    // 这一份回答就是裁判点评吗：满十局要在点评末尾摆打赏。只认评完那一刻报上来的那一局，
    // 认领一次就清掉，别的回合不会再摆。
    let giftRounds = 0
    try {
      if (gifted.due && gifted.due(options?.sessionId) && typeof clinicGiftOf === 'function') {
        const taken = clinicGiftOf(options?.sessionId)
        giftRounds = taken ? Number(taken.rounds) || 1 : 0
      }
    } catch (error) {
      giftRounds = 0
    }
    let head = ''
    let tailText = ''
    let giftSent = false
    let maxSeen = -1
    // 打赏块自己开、自己收：满十局的那一份点评末尾补一块，别的时候什么都不发。
    const sendGift = function* () {
      if (giftSent) return
      giftSent = true
      try {
        // 模型偶尔还是会把打赏那段自己写出来（开头或结尾都有），见到了就不再补第二块。
        const wrote = head.includes('请作者喝杯茶') || tailText.includes('请作者喝杯茶')
        const gift = wrote ? '' : dashangGiftText(giftRounds, ctx)
        if (!gift) return
        const index = maxSeen + 1
        maxSeen = index
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: gift }
        yield { type: 'block-end', index, block: { type: 'text', text: gift } }
      } catch (error) {
        ctx.logger?.warn?.('学理模式：打赏区没加上（不影响回答）：%o', error)
      }
    }
    for await (const chunk of next()) {
      if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') {
        yield chunk
        continue
      }
      // 闭嘴的一轮：正文块照开照收，但文字全部清空；结束块与正文块末的全文也要清，
      // 免得宿主最后按 block-end 里的全文把这一整段又显示出来。
      if (simMute) {
        // 只清文字，别的块一个都不许丢：工具调用的 name/参数也走在这些块里，
        // 漏掉就会变成宿主那边「Error: unknown tool」的空名字调用。
        if (chunk.type === 'text-delta') continue
        if (chunk.block && typeof chunk.block.text === 'string') {
          yield { ...chunk, block: { ...chunk.block, text: '' } }
          continue
        }
        if (typeof chunk.text === 'string') {
          yield { ...chunk, text: '' }
          continue
        }
        yield chunk
        continue
      }
      if (typeof chunk.index === 'number' && chunk.index > maxSeen) maxSeen = chunk.index
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        if (head.length < 64) head += chunk.text
        tailText = (tailText + chunk.text).slice(-64)
      }
      // 满十局的那一份点评，末尾由代码补打赏区；模型自己写了的不补，免得重复。
      if (chunk.type === 'finish') yield* sendGift()
      yield chunk
    }
    // 宿主偶尔不给 finish：流结束前再兜一次，免得打赏区整块漏掉。
    yield* sendGift()
  }

  return { stream, muted }
}