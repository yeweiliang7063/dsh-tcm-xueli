import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  squash,
  bookName,
  splitPassages,
  grams,
  scoreText,
  usableQuery,
  parseHerbText,
  findHerbEntries,
  findPassages,
  loadCorpus,
  mountSearchRoute,
} from '../lib/search.js'

test('书名与空白：文件名去编号去扩展名，压缩文本去掉所有空白', () => {
  assert.equal(bookName('01-黄帝内经素问.txt'), '黄帝内经素问')
  assert.equal(bookName('10-神农本草经.md'), '神农本草经')
  assert.equal(squash(' 上 古 天 真 论 '), '上古天真论')
})

test('切段：按空行分段，记住篇名，太短的段不要', () => {
  const raw = [
    '上古天真论篇第一',
    '昔在黄帝，生而神灵，弱而能言，幼而徇齐，长而敦敏，成而登天。',
    '',
    '乃问于天师曰：余闻上古之人，春秋皆度百岁，而动作不衰。',
  ].join('\n')
  const got = splitPassages('01-黄帝内经素问.txt', raw)
  assert.equal(got.length, 2)
  assert.ok(got[0].source.includes('黄帝内经素问'))
  assert.ok(got[0].source.includes('上古天真论篇第一'), '出处要带篇名')
  assert.ok(got[1].text.includes('春秋皆度百岁'))
})

test('长段按句切开，不会一段几千字塞爆面板', () => {
  const sentence = '春三月，此谓发陈，天地俱生，万物以荣。'
  const raw = '四气调神大论篇第二\n' + sentence.repeat(60)
  const got = splitPassages('01-黄帝内经素问.txt', raw)
  assert.ok(got.length >= 2)
  for (const piece of got) assert.ok(piece.text.length <= 900)
})

test('词组：整句排最前，再按两字滑窗', () => {
  const list = grams('少阴病')
  assert.equal(list[0], '少阴病')
  assert.ok(list.includes('少阴'))
  assert.ok(list.includes('阴病'))
})

test('打分：命中多的分高，整句命中给大分', () => {
  const list = grams('少阴病')
  assert.ok(scoreText('少阴之为病，脉微细，但欲寐也。', list) > 0)
  assert.equal(scoreText('太阳之为病，脉浮，头项强痛而恶寒。', list), 0)
})

test('乱输的不查：空、一个字的都算没输入', () => {
  assert.equal(usableQuery(''), false)
  assert.equal(usableQuery('  ，。 '), false)
  assert.equal(usableQuery('痰'), false)
  assert.equal(usableQuery('便秘'), true)
  assert.equal(usableQuery('why 便秘'), true)
})

test('找段落：按命中排序、去重、限量', () => {
  const corpus = [
    { source: '伤寒论 · 辨少阴病脉证并治', text: '少阴之为病，脉微细，但欲寐也。' },
    { source: '伤寒论 · 辨太阳病脉证并治', text: '太阳之为病，脉浮，头项强痛而恶寒。' },
    { source: '伤寒论 · 辨少阴病脉证并治', text: '少阴病，得之二三日，麻黄附子甘草汤微发汗。' },
    { source: '伤寒论 · 辨少阴病脉证并治', text: '少阴之为病，脉微细，但欲寐也。' },
  ]
  const got = findPassages(corpus, '少阴病', 6)
  assert.equal(got.length, 2, '重复的一段只要一次，没命中的不要')
  assert.ok(got[0].text.includes('少阴'))
  assert.ok(got.every((x) => x.text.includes('少阴')))
})

test('读资料库：五分类都扫（含子目录），医案不收，坏文件跳过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tcm-search-'))
  try {
    await mkdir(join(root, 'text'), { recursive: true })
    await mkdir(join(root, '名著'), { recursive: true })
    await mkdir(join(root, '医案'), { recursive: true })
    await writeFile(join(root, 'text', '03-伤寒论.txt'), '辨太阳病脉证并治上\n太阳之为病，脉浮，头项强痛而恶寒。\n', 'utf8')
    await writeFile(join(root, '名著', '脾胃论.md'), '脾胃虚实传变论\n脾胃之气既伤，而元气亦不能充，而诸病之所由生也。\n', 'utf8')
    await writeFile(join(root, '医案', '不该读.txt'), '这里的内容不该进查询范围。\n', 'utf8')
    // 坏文件夹具：建一个名为 坏文件.txt 的目录，readFile 必然失败，验证真的会跳过。
    await mkdir(join(root, 'text', '坏文件.txt'), { recursive: true })
    const corpus = await loadCorpus(root)
    assert.ok(corpus.length >= 2)
    assert.ok(corpus.some((x) => x.source.includes('伤寒论')))
    assert.ok(corpus.some((x) => x.source.includes('脾胃论')))
    assert.ok(!corpus.some((x) => x.text.includes('不该进')))
    assert.ok(!corpus.some((x) => x.source.includes('坏文件')), '读不动的必须跳过')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读资料库：方药/经典与嵌套子目录能搜到，各级医案与索引都不收', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tcm-search-dirs-'))
  try {
    await mkdir(join(root, '方药', '内科'), { recursive: true })
    await mkdir(join(root, '方药', '医案'), { recursive: true })
    await mkdir(join(root, '经典'), { recursive: true })
    await writeFile(join(root, '方药', '济世良方.txt'), '太阳之为病，脉浮，头项强痛而恶寒。桂枝汤主之，服已须臾啜热稀粥。\n', 'utf8')
    await writeFile(join(root, '方药', '内科', '杂病方.txt'), '脾胃虚弱，饮食不化，宜健脾益气，方用四君子汤加减，缓缓图之。\n', 'utf8')
    await writeFile(join(root, '经典', '伤寒论.txt'), '少阴之为病，脉微细，但欲寐也。少阴病，得之二三日，麻黄附子甘草汤微发汗。\n', 'utf8')
    await writeFile(join(root, '经典', '索引.md'), '这是插件生成的索引，不该当成书来搜，索引内容也不该进查询。\n', 'utf8')
    await writeFile(join(root, '方药', '医案', '私藏医案.txt'), '这是嵌套医案里的隐私内容，绝不许进检索范围，谁都不许搜到。\n', 'utf8')
    const corpus = await loadCorpus(root)
    assert.ok(corpus.some((x) => x.source.includes('济世良方')), '方药/ 下的书要能搜到')
    assert.ok(corpus.some((x) => x.source.includes('杂病方')), '嵌套子目录要能搜到')
    assert.ok(corpus.some((x) => x.source.includes('伤寒论')), '经典/ 下的书要能搜到')
    assert.ok(!corpus.some((x) => x.source.includes('索引')), '各级 索引.md 都不收')
    assert.ok(!corpus.some((x) => x.text.includes('隐私内容')), '嵌套医案绝不进检索')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读资料库：GBK 编码的书按探测解码，内容搜得到', async () => {
  // 「太阳之为病，脉浮，头项强痛而恶寒。」的 GB18030 字节。
  const gbk = Buffer.from([
    0xCC, 0xAB, 0xD1, 0xF4, 0xD6, 0xAE, 0xCE, 0xAA, 0xB2, 0xA1, 0xA3, 0xAC,
    0xC2, 0xF6, 0xB8, 0xA1, 0xA3, 0xAC, 0xCD, 0xB7, 0xCF, 0xEE, 0xC7, 0xBF,
    0xCD, 0xB4, 0xB6, 0xF8, 0xB6, 0xF1, 0xBA, 0xAE, 0xA1, 0xA3,
  ])
  assert.equal(new TextDecoder('gb18030').decode(gbk), '太阳之为病，脉浮，头项强痛而恶寒。', '夹具字节先自校验')
  const root = await mkdtemp(join(tmpdir(), 'tcm-search-gbk-'))
  try {
    await mkdir(join(root, 'text'), { recursive: true })
    await writeFile(join(root, 'text', '伤寒论GBK.txt'), Buffer.concat([Buffer.from('ShangHanLun GBK edition\n', 'ascii'), gbk]))
    const corpus = await loadCorpus(root)
    assert.ok(corpus.some((x) => x.text.includes('太阳之为病')), 'GBK 的书要解码成中文再进检索')
    assert.ok(!corpus.some((x) => x.text.includes('\uFFFD')), '不许带乱码 replacement 字符')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读资料库：递归深度超过 4 层的不再收', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tcm-search-depth-'))
  try {
    await mkdir(join(root, 'text', 'a', 'b', 'c', 'd', 'e'), { recursive: true })
    await writeFile(join(root, 'text', 'a', 'b', 'c', 'd', '浅书.txt'), '这本书在第四层子目录里，内容足够长，应当被收进检索范围。\n', 'utf8')
    await writeFile(join(root, 'text', 'a', 'b', 'c', 'd', 'e', '深书.txt'), '这本书在第五层子目录里，内容足够长，但不该被收进检索范围。\n', 'utf8')
    const corpus = await loadCorpus(root)
    assert.ok(corpus.some((x) => x.source.includes('浅书')), '第 4 层要收')
    assert.ok(!corpus.some((x) => x.source.includes('深书')), '第 5 层不收')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读资料库：文件总数封顶 2000，不把内存读爆', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tcm-search-cap-'))
  try {
    await mkdir(join(root, 'text'), { recursive: true })
    const body = '这是一本用来测试数量上限的书，内容要足够长才能成为一段原文。\n'
    await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(join(root, 'text', `书${i}.txt`), body, 'utf8')))
    const corpus = await loadCorpus(root)
    assert.equal(corpus.length, 2000, '2001 本只收前 2000 本')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('本草条目：拆出原文、性味、功效、产地', () => {
  const one = parseHerbText('牡桂：味辛，温，主上气咳逆，结气，喉痹吐吸。利关节，补中益气。久服通神。生山谷。一名肉桂，一名桂枝。')
  assert.equal(one.head, '牡桂')
  assert.equal(one.nature, '味辛，温')
  assert.ok(one.effect.includes('上气咳逆'))
  assert.equal(one.origin, '山谷')
  assert.deepEqual(one.aliases, ['肉桂', '桂枝'])
})

test('本草条目：别名能查到，长得像的药名不误伤', () => {
  const corpus = [
    { source: '神农本草经', text: '牡桂：味辛，温，主上气咳逆，结气。生山谷。一名肉桂，一名桂枝。' },
    { source: '神农本草经', text: '大黄豆卷：味甘，平。主湿痹，筋挛，膝痛。生平泽。' },
    { source: '伤寒论', text: '桂枝汤：太阳中风，阳浮而阴弱。' },
  ]
  const got = findHerbEntries(corpus, '桂枝', 4)
  assert.equal(got.length, 1)
  assert.equal(got[0].source, '神农本草经')
  assert.equal(got[0].meta.origin, '山谷')
  assert.equal(findHerbEntries(corpus, '大黄', 4).length, 0, '大黄豆卷不算大黄')
  assert.equal(findHerbEntries(corpus, '桂枝汤', 4).length, 0, '超过六个字不当单味药')
})
