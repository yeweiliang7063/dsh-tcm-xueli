/**
 * 资料库根目录的锁定工具。
 *
 * 规矩只有一条：库根就是「用户在设置里填的那一行」，代码只认它，不认文件夹名字，
 * 也不在外面找替代目录。所有要落盘的东西（索引.md、医案、补进的经典、挪动的书目）
 * 都必须真在这个根里面；算出根外面的路径，一律当错误，直接不写。
 */
import path from 'node:path'
import { realpathSync } from 'node:fs'

const WINDOWS = process.platform === 'win32'

/** 统一写法：解析成绝对路径，去掉结尾分隔符（盘符根除外），Windows 下不分大小写。 */
export function normalizeRoot(dir) {
  const text = String(dir || '').trim()
  if (text === '') return ''
  let resolved = ''
  try {
    resolved = path.resolve(text)
  } catch {
    return ''
  }
  const trimmed = resolved.replace(/[\\/]+$/, '')
  const base = trimmed === '' ? resolved : trimmed
  return WINDOWS ? base.toLowerCase() : base
}

/**
 * 尽量解析真实路径：叶子不存在时沿祖先上爬，找到第一个存在的再拼回剩余段。
 * 这样「库内 junction ＋ 尚不存在的新文件」也能解析出 junction 指向的真实位置。
 * 一路都解析不出（整条路径不存在等）返回空串。
 */
function realOf(p) {
  const rest = []
  let cur = p
  for (;;) {
    try {
      const real = realpathSync(cur)
      return rest.length === 0 ? real : path.join(real, ...rest.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return ''
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

/** target 是不是 root 自己或 root 里面的东西（不含「名字以 root 开头」的旁边目录）。 */
export function insideRoot(root, target) {
  const base = normalizeRoot(root)
  const child = normalizeRoot(target)
  if (base === '' || child === '') return false
  if (base === child) return true
  const guard = base.endsWith(path.sep) ? base : base + path.sep
  if (!child.startsWith(guard)) return false
  // 词法在根内还不够：库里的 junction/符号链接能把写操作引出根。
  // 路径存在时用 realpath 解析后再比一遍；解析不出就退回词法结果（不抛）。
  try {
    const realBase = realOf(base)
    const realChild = realOf(child)
    if (realBase === '' || realChild === '') return true
    const a = WINDOWS ? realBase.toLowerCase() : realBase
    const b = WINDOWS ? realChild.toLowerCase() : realChild
    if (a === b) return true
    const realGuard = a.endsWith(path.sep) ? a : a + path.sep
    return b.startsWith(realGuard)
  } catch {
    return true
  }
}

/** 在 root 底下拼一个子路径；拼出来跑到根外面就返回空串，让调用方放弃这次写入。 */
export function childOf(root, ...parts) {
  const base = normalizeRoot(root)
  if (base === '') return ''
  let joined = ''
  try {
    joined = path.join(root, ...parts)
  } catch {
    return ''
  }
  return insideRoot(root, joined) ? joined : ''
}