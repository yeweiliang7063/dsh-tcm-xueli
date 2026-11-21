/**
 * 学理模式 · 宿主半（只做组装）
 *
 * 两块功能各在自己的文件里，互不引用，也互不牵连：
 * - 经方学习版 → lib/xuexi.js：提示词变量、资料库维护、出口剂量遮挡、只读检索页；
 * - 模拟问诊   → lib/sim.js：思考开关、病例卡工具、闭麦、点评末尾的打赏。
 *
 * 这里只做三件事：读设置、把两块分别装起来（各管各的 try/catch，一块坏了另一块照常）、
 * 在出口那一层把两个包装器串起来（问诊那个在内层先走，学习版那个在外层后走）。
 * 任何一块装载失败都只记日志，绝不影响 DSH 主体启动。
 */
import z from '@deepseek-ai/schemastery'
import { versionOf } from './preset-scope.js'
import { applySim } from './sim.js'
import { DEFAULT_KB, applyXuexi, currentPath, resolveUserDir } from './xuexi.js'

export const name = 'dsh-tcm-xueli'
/** 只等提示词服务；Web 服务与模型服务都在用时按需取，缺了不影响会话。 */
export const inject = ['systemPrompt']

/** 资料库路径与路径还原是公开接口（设置页与测试都用它们）。 */
export { currentPath, resolveUserDir }

/**
 * 设置页「中医 · 经方（学习版）｜资料库目录」里只有一项可改：资料库目录。
 * 标 volatile：路径里带用户名、盘符，不必写进会话档案。
 */
export const Config = z.object({
  kbPath: z.string().default(DEFAULT_KB).volatile(),
  autoIndex: z.boolean().default(true).description('按资料库目录自动生成 索引.md'),
})

export function apply(ctx, config) {
  const api = { name, currentPath, versionOf }

  // 学习版：装载失败就整块缺席，问诊照旧。
  let xuexi = null
  try {
    xuexi = applyXuexi(ctx, config, api)
  } catch (error) {
    ctx.logger?.warn?.('学理模式：学习版装载失败（问诊不受影响）：%o', error)
  }

  // 模拟问诊：装载失败就整块缺席，学习版照旧。
  let sim = null
  try {
    sim = applySim(ctx, config, api)
  } catch (error) {
    ctx.logger?.warn?.('学理模式：模拟问诊装载失败（学习版不受影响）：%o', error)
  }

  // 出口那一层只挂一次：内层交给问诊（闭麦、补打赏），外层交给学习版（提醒、遮剂量）。
  // hint 是两块之间唯一的通信：问诊说这一轮闭麦，学习版就少插一句提醒，别的什么都不传。
  // 任何一块在流里抛错，都只记日志、把上游剩下的块原样放行——另一块和这一轮回答都不受牵连。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('llm/stream', (options, next) => {
        const hint = {}
        const upstream = next()
        const inner = sim ? sim.stream(options, () => upstream, hint) : upstream
        const outer = xuexi ? xuexi.stream(options, () => inner, hint) : inner
        return (async function* () {
          try {
            yield* outer
          } catch (error) {
            ctx.logger?.warn?.('学理模式：出口包装器出错，剩下的回答原样放行：%o', error)
            try {
              for await (const chunk of upstream) yield chunk
            } catch (rest) {
              /* 上游自己也断了，就不再兜 */
            }
          }
        })()
      })
    }
  } catch (error) {
    ctx.logger?.warn?.('学理模式：出口校验注册失败，本次只靠提示词约束：%o', error)
  }
}