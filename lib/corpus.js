/**
 * 随包资料（学理模式版）
 *
 * 插件包里的 corpus/ 放随包经典的纯文本；启动时只把「资料库里还没有」的文件
 * 复制到 <资料库>/text/，不覆盖用户自己整理过的版本。
 *
 * 学理模式下不再随包发检索规程与出方规程：资料库里只补书，不补规程，
 * 免得预设旧副本把已经改掉的口径又带回来。复制失败只记日志，不影响会话与启动。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORPUS_DIR = join(ROOT_DIR, 'corpus')

/**
 * 把包内 corpus/*.md 补到 <kb>/text/。
 * @param {string} kb 资料库根目录（已确认存在）
 * @param {object} [logger] 可选日志器；失败时 warn，不抛（缺省保持旧行为）
 * @returns {number} 本次新复制的文件数
 */
export function ensureCorpus(kb, logger) {
  const warn = (msg, error) => {
    if (logger && typeof logger.warn === 'function') logger.warn(msg, error)
  }
  if (!kb || !existsSync(kb) || !existsSync(CORPUS_DIR)) return 0
  const target = join(kb, 'text')
  try {
    mkdirSync(target, { recursive: true })
  } catch (error) {
    warn('中医 · 经方：随包资料目录 %s 建立失败（下次启动再试）：%o', target, error)
    return 0
  }

  let copied = 0
  let names = []
  try {
    names = readdirSync(CORPUS_DIR)
  } catch (error) {
    return 0
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue
    // README／说明／目录／凡例是语料说明，不是书：不往 text/ 里拷。
    if (/^(?:readme|说明|目录|凡例)\.md$/i.test(name)) continue
    const src = join(CORPUS_DIR, name)
    const dst = join(target, name)
    // 已经有一份好的就不用重拷；但长度是 0 的多半是上次拷到一半断了，补一份。
    if (existsSync(dst)) {
      try {
        if (statSync(dst).size > 0) continue
      } catch (error) {
        continue
      }
    }
    try {
      // 先写临时名再改名：中途断电/退出只会留下 .tmp，不会被当成一本好书永远跳过。
      const tmp = dst + '.' + process.pid + '.tmp'
      copyFileSync(src, tmp)
      renameSync(tmp, dst)
      copied += 1
    } catch (error) {
      // 单本复制失败不影响其它书；下次启动还会再试。失败要记日志，不静默吞。
      try { unlinkSync(dst + '.' + process.pid + '.tmp') } catch (e) { /* 没写出来就不用清 */ }
      warn('中医 · 经方：随包资料《' + name + '》复制失败（下次启动再试）：%o', error)
    }
  }
  return copied
}

export { CORPUS_DIR }