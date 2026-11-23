/**
 * 学理模式 · 出口校验（纯函数，方便单测）
 *
 * 两件事：
 * 1. 判断一段助手回答里有没有「具体剂量」的数值写法；
 * 2. 把这种数值整截遮成 *，只用于显示层兜底。
 *
 * 2026-11-16 修订：从「挖掉整句」改成「只遮数值」。
 * - 旧版把命中剂量的整个分句换成 *，药名和句子骨架一起没了，读者只看到一个孤零零的 *；
 *   现在只把「数字＋单位」这一截换成 *，药名与前后文原样留着：桂枝 9 克 → 桂枝*。
 * - 列表项前缀（行首「2. **药名**」「- **药名**：」）永不参与打码，列表结构不会被挖断。
 * 只认「数字＋克/g/毫克/千克/grams/kg」这一路：桂枝9克、黄芪30g。两、钱、枚、升、合这些经典计量不动，
 * 它们本来就不是抓药的克数，遮了只让原文读不通。
 * 明确不碰：「六经」这类词里的「六」、「第 35 条」这类条号、「1.5 小时」这类时长、「十天半月」这类口语。
 *
 * 放行凭据是引号＋验真：整段原文放进「」『』“”里、且不含现代克数才不遮（见 quotedRanges、doseSpans）；
 * 引号里一旦出现「数字＋克/g」就认定非古籍原文，豁免取消照遮。括号里的「原文：……」、段首的「按图上原文」都不算凭据。
 *
 * 2026-11-14 修订：
 * - 原写法「(?:数)+ + 两」把「三两」看成一个数，导致原文剂量直接漏拦，已修；
 * - 「两」不再一律当单位：「一两点醒」「两三天」「两包烟」「两两相望」「一共三两」都不判剂量；
 * - 补上漏拦的可照抓写法：半片、两包、两把、两贴、每日三服；
 *   【已作废，见下】3.2.5 起口径收为「只遮克/g」：片、包、剂、服、毫升一律不遮，
 *   上一条只留在历史里，现行行为以 DOSE_UNITS 与 gear.test.mjs 的断言为准；
 * - 阿拉伯数字后面的 g／ml 不接字母，「158cm」不再被当成「158 毫升」。
 */

/** 中文数字字形（不含「两」，两单独处理）。 */
const HAN = '一二三四五六七八九十百千半'
/** 后面接这些字时，「数 + 量词」多半是普通说话，不是剂量。（口/分/日 已移除：9克口服、9克分服、9克日二次是真剂量。） */
const NOT_DOSE_NEXT = '天月年次回趟遍杯碗个人位岁斤米里步层届期点秒刻号生肖烟切擘碎极字行句篇条首页项级倍成折遍样所间门类种批轮'
/** 这些字出现在「数 + 量词」前面时，通常不是剂量。（差/余 已移除：还差9克、剩余9克是真剂量；统 加入：统一克数不是给量。） */
const NOT_DOSE_PREV = '不没每若干多好逾开统'
/** 「两」后面接这些字时，「两」不是剂量单位（一共三两、十两银子、两千下红、两两相望）。 */

/** 数字字形：半角全角都认，混写也认（３.5、3．5 一律算数）。 */
const DIG = String.raw`(?:\d|[０-９])`
/** 数字写法：阿拉伯数字（含混写小数），或「两/几/数」加中文数字拼起来的数目（两包、几克、数枚、十二枚）。 */
const NUM = String.raw`(?:${DIG}+(?:[.．]${DIG}+)?|[两几数]?[${HAN}]+|[两几数])`
/** 范围写法：3-9克、三至九克——下限也是剂量，整截一起遮。 */
const RANGE_HEAD = String.raw`(?:${NUM}\s*[-～~—至到]\s*)?`

/**
 * 数字后接 g：后面不能紧跟字母，免得 GB、GIF 这类单词被当成剂量。
 * 现行口径（2026-11）：只遮「克」前面的数字；毫升、两、钱、枚这些经典计量不遮。
 */
function latinHitRe() {
  // 全角数字、全角 Ｇ、毫克／公克／千克／公斤／mg／gm／ｍｇ／grams／kg 都要认：漏一个就等于没遮。
  const num = String.raw`(?:${RANGE_HEAD}(?:${DIG}+(?:[.．]${DIG}+)?|[一二三四五六七八九十百千半]+)\s*(?:余|多|许)?\s*)`
  const unit = String.raw`(?:[（(]\s*(?:毫克|公克|千克|公斤|kilograms?|grams?|kgs?|mg|gm|[gGＧ]|[ｍＭ][ｇＧ])\s*[）)]|(?:毫克|公克|千克|公斤|kilograms?|grams?|kgs?|mg|gm|[gGＧ]|[ｍＭ][ｇＧ]))`
  return new RegExp(num + unit + String.raw`(?![a-zA-Z])`, 'gi')
}

/** 需要遮的量词：只剩「克」这一路（含「克重」与拉丁写法 g）。 */
const DOSE_UNITS = ['克重', '克', '剋', '尅']

/**
 * 单个「数 + 单位」的正则。
 * 组合放在函数里而不是模板字符串里，免得正则里的字符类提前生效。
 */
function doseOneOf(unit) {
  const head = String.raw`(?<![${HAN}\d０-９])(?<![${NOT_DOSE_PREV}])${RANGE_HEAD}${NUM}\s*(?:余|多|许)?\s*(?:[（(]${unit}[）)]|${unit})`
  return new RegExp(head + String.raw`(?![${NOT_DOSE_NEXT}])`, 'g')
}

/** 各类「数 + 单位」编译一次，重复使用（带 g 标志，用前要重置 lastIndex）。 */
const DOSE_CACHE = Object.fromEntries(DOSE_UNITS.map((unit) => [unit, doseOneOf(unit)]))

/** 条号、章节号、卷次不算剂量：先剥掉再判。 */
const ARTICLE_MARK = /第\s*\d+\s*(?:条|篇|难|章|节|卷|门|集)|宋本\s*第?\s*\d+|卷\s*[一二三四五六七八九十\d]+/g

/** 比例说法本身（「1 比 1」「二比一」）：这几个字不是剂量。 */
const RATIO_ITEM = /\d+\s*[:：比]\s*\d+|[一二三四五六七八九十]\s*比\s*[一二三四五六七八九十]/g

/** 在文本里把指定区间换成等长空格：位置不变，遮数字时仍按原文位置走。 */
function blankRanges(text, ranges) {
  if (ranges.length === 0) return text
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [a, b] of sorted) {
    if (b <= cursor) continue
    const s = Math.max(a, cursor)
    out += text.slice(cursor, s) + ' '.repeat(b - s)
    cursor = b
  }
  return out + text.slice(cursor)
}

/** 把一个正则命中的区间全收出来。 */
function regexRanges(text, re) {
  const out = []
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length])
  return out
}

/** 把互相重叠的区间并起来，一处剂量只遮一次。 */
function mergeSpans(spans) {
  if (spans.length < 2) return spans
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const out = [sorted[0].slice()]
  for (const [s, e] of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/**
 * 收集「数＋克」这一路的命中区间（含复述禁令豁免）。
 * 「一克都不许给」这类复述禁令的话不是给量：只豁免「一克」紧跟否定语境这一种。
 */
function unitSpans(deep) {
  const spans = []
  for (const unit of DOSE_UNITS) {
    const re = DOSE_CACHE[unit]
    re.lastIndex = 0
    for (const m of deep.matchAll(re)) {
      if (m[0] === '一克' && /^(?:都不|不许|不给|没有)/.test(deep.slice(m.index + m[0].length))) continue
      spans.push([m.index, m.index + m[0].length])
    }
  }
  return spans
}

/** 收集拉丁/公制单位命中（g／毫克／千克／公斤／grams／kg）；体重身高后的公斤/千克是体重，不是给药量，放过。 */
function latinSpans(base) {
  const spans = []
  for (const m of base.matchAll(latinHitRe())) {
    if (/(?:千克|公斤)/.test(m[0]) && /(?:体重|身高|胖瘦)[^，。；]{0,8}$/.test(base.slice(0, m.index))) continue
    spans.push([m.index, m.index + m[0].length])
  }
  return spans
}

/** 针法、灸法、剂数、服法里的数：同样是「照做就有风险」的量，和克数一起遮。 */
function needleSpans(text) {
  const spans = []
  // 带两/钱/枚/升/合的古文里，「分温三服」是原方煎服法，照引不遮；
  // 没有这些古制单位的现代写法，才按医嘱把服次、针法深度遮掉。
  const classical = /[两钱枚升合]/.test(text)
  const num = String.raw`(?:\d|[０-９])+(?:[.．](?:\d|[０-９])+)?|[一二三四五六七八九十百千半两]{1,4}`
  // 「针十分」多半是「十分必要」，不把「十」当针法深度；刺入/直刺仍认十。
  const needleNum = String.raw`(?:\d|[０-９])+(?:[.．](?:\d|[０-９])+)?|[一二三四五六七八九半两]{1,4}`
  const add = (m, from = 0) => {
    const chunk = m[0]
    const at = chunk.slice(from).search(/[\d０-９一二三四五六七八九十半两]/)
    if (at < 0) return
    spans.push([m.index + from + at, m.index + chunk.length])
  }
  // 刺法：动词或「深/深度」后紧跟数字，再寸/分；支持 0.5～0.8 寸。
  const needling = new RegExp(String.raw`(?:直刺|斜刺|平刺|透刺|进针|刺入|针入|针刺|深度|深)\s*(${num})(?:\s*[-～~—至到]\s*(?:${num})\s*)?\s*(?:寸|分)`, 'g')
  if (!classical) for (const m of text.matchAll(needling)) add(m)
  // 「针三分」「针 1.5 寸」：针后直接跟数。
  const needleOnly = new RegExp(String.raw`针\s*(${needleNum})(?:\s*[-～~—至到]\s*(?:${needleNum})\s*)?\s*(?:寸|分)`, 'g')
  if (!classical) for (const m of text.matchAll(needleOnly)) add(m)
  // 留针只认「分钟／小时」，避免「留针十分必要」被误遮。
  const retain = new RegExp(String.raw`留针\s*(${num})\s*(?:分钟|小时)`, 'g')
  if (!classical) for (const m of text.matchAll(retain)) add(m)
  if (!classical) for (const m of text.matchAll(/留针\s*半\s*小时/g)) add(m)
  const moxa = new RegExp(String.raw`灸\s*(${num})\s*壮`, 'g')
  if (!classical) for (const m of text.matchAll(moxa)) add(m)
  // 剂数。
  for (const m of text.matchAll(/(?:连服|共服|共|服)\s*([\d０-９一二三四五六七八九十半两]{1,4})\s*剂/g)) add(m)
  for (const m of text.matchAll(/(?<![调配方制])[\d０-９一二三四五六七八九十半两]{1,4}\s*剂/g)) add(m, 0)
  // 每日／一日／日 + 数 + 服／次；「分温三服」「分两次服」也算。
  const freq = new RegExp(String.raw`(?:每日|每天|一日|一天|日|分温|分|温)\s*(${num})\s*(?:次|服)(?:\s*服)?`, 'g')
  if (!classical) for (const m of text.matchAll(freq)) add(m)
  return mergeSpans(spans)
}

/** 不剥引文，直接找「数字＋单位」的位置（引文验真要用）。 */
function rawDoseSpans(text) {
  const base = blankRanges(text, regexRanges(text, ARTICLE_MARK))
  const deep = blankRanges(base, regexRanges(base, RATIO_ITEM))
  return mergeSpans(latinSpans(base).concat(unitSpans(deep)))
}

/**
 * 找出文本里所有真正算剂量的「数字＋单位」位置 [起, 止)。
 * 判定口径：引文验真（含现代克数的引文取消豁免）、比例说法、条号先排除，剩下的才是自己给的量。
 * @param {string} text
 */
function doseSpans(text) {
  if (typeof text !== 'string' || text === '') return []
  // 引文验真：经典原文用两、钱、枚，不用现代克数——引号里出现「数字＋克/g」，
  // 几乎必是转述或自拟方，取消这一段的豁免，照遮；不含现代克数的引文才放过。
  const raw = rawDoseSpans(text)
  const exempt = quotedRanges(text).filter(([a, b]) => !raw.some(([s, e]) => s >= a && e <= b))
  let base = blankRanges(text, exempt)
  base = blankRanges(base, regexRanges(base, ARTICLE_MARK))
  // ① 阿拉伯数字带 g／毫克／千克／grams／kg（体重身高后的公斤/千克放过）
  const spans = latinSpans(base)
  // ② 中文「数＋克」：先把「1 比 1」这种比例本身抹掉，再按单味药逐个判
  const deep = blankRanges(base, regexRanges(base, RATIO_ITEM))
  return mergeSpans(spans.concat(unitSpans(deep)).concat(needleSpans(base)))
}

/** 一段文字里是否出现了具体剂量。 */
export function hasDosage(text) {
  return doseSpans(text).length > 0
}

/**
 * 把剂量数值打码：「数字＋单位」整截换成 *，药名和前后文原样留着（桂枝 9 克 → 桂枝*）。
 * 只打「克」这一路；两、钱、枚这些经典计量与原文引文一律不动。
 * @param {string} text
 * @returns {string}
 */
/** 显示层兜底：与出口同一套判据，别留两套口径。 */
export function maskDosage(text) {
  return blotDosage(text, '*')
}
/**
 * 引号配对：只认「」『』“”，逐字扫，配对成功且合规才算「原文照引」。
 * 任何一条不合规，一律按自己复述处理，剂量照遮：
 * ① 开合必须成对——只有开头没结尾的，就当没加引号；
 * ② 一句引文最多 QUOTE_MAX 字——再长就不是引一句，是整段搬；
 * ③ 不跨空行、不跨代码块围栏——跨了就不算「引一句原文」。
 */
const QUOTE_PAIRS = { '「': '」', '『': '』', '“': '”' }
const QUOTE_MAX = 240

/** 合规的引文区间 [起, 止)。 */
export function quotedRanges(text) {
  const out = []
  if (typeof text !== 'string' || text === '') return out
  let i = 0
  while (i < text.length) {
    const open = text[i]
    const close = QUOTE_PAIRS[open]
    if (!close) {
      i += 1
      continue
    }
    let j = i + 1
    let ok = false
    while (j < text.length) {
      const ch = text[j]
      if (ch === close) {
        ok = true
        break
      }
      if (ch === open) break // 同类引号又开了一次：这一段没配对
      if (ch === '\n') {
        const next = text.slice(j + 1, j + 8)
        if (/^\s*\n/.test(next) || /^\s*(```|~~~)/.test(next)) break
      }
      if (j - i - 1 >= QUOTE_MAX) break
      j += 1
    }
    if (ok) {
      out.push([i, j + 1])
      i = j + 1
    } else {
      i += 1
    }
  }
  return out
}

/**
 * 把引文段落换成空格（保留长度，位置不变），剩下的才是自己说的话。
 * 只认「」『』“”这一种凭据：括号里的「原文：……」、段首的「按图上原文」都不算数。
 * @param {string} text
 * @returns {string}
 */
export function stripQuoted(text) {
  if (typeof text !== 'string' || text === '') return text
  return blankRanges(text, quotedRanges(text))
}

/**
 * 流式切句的安全切点：切点落在引号中间（引文还没闭合）时前移到开引号处，
 * 免得一块只剩半个引文、被当成「没加引号」误遮；返回 0 表示这块先别发，等下一块。
 * @param {string} text 当前缓冲
 * @param {number} cut 原定切点
 * @returns {number}
 */
export function quoteSafeCut(text, cut) {
  if (!(cut > 0)) return cut
  // 缓冲太长还没闭合的引号，不是「引一句原文」，别再往后挪，照常发（会被当没加引号遮掉），
  // 否则一个忘写收尾的引号能把整轮回答一直扣在缓冲里。
  if (text.length > QUOTE_MAX * 3) return cut
  let safe = cut
  const pairs = quotedRanges(text)
  for (const [a, b] of pairs) {
    if (a < safe && safe < b) {
      safe = a
      break
    }
  }
  // 还没闭合的开引号（含被「超长／跨空行」判无效的引文）：切点前移到引号处，等它闭合再判
  for (let i = 0; i < safe; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(QUOTE_PAIRS, text[i])) continue
    if (pairs.some(([a, b]) => i >= a && i < b)) continue
    safe = i
    break
  }
  return safe
}

/**
 * 把文本里所有具体剂量的「数字＋单位」换成占位符，药名和句子骨架原样留着。
 * 列表项前缀、引号里的原文不碰（见 doseSpans）。
 * @param {string} text
 * @param {string} [mark] 占位符，默认 *
 * @returns {string}
 */
export function blotDosage(text, mark = '*') {
  if (typeof text !== 'string' || text === '') return text
  const spans = doseSpans(text)
  if (spans.length === 0) return text
  let out = ''
  let cursor = 0
  for (const [start, end] of spans) {
    out += text.slice(cursor, start) + mark
    cursor = end
  }
  out += text.slice(cursor)
  return tidyBlot(out)
}

/**
 * 遮完清掉留下的残缺符号：空括号、连着两个的顿挫、冒号后直接跟逗号。
 * @param {string} text
 * @returns {string}
 */
function tidyBlot(text) {
  return text
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[，、]{2,}/g, '，')
    .replace(/([：:])\s*[，、]/g, '$1')
}
