import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeBytes, extractBookText } from '../lib/book-text.js'

function crc32() {
  return 0 // 读取端不校验 CRC，测试夹具用 0 即可。
}

/** 造一个最小的 store 模式 ZIP，够 docx/epub 测试用。 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.data, 'utf8')
    // file.deflate 为真时按 deflate 压缩存进去：大条目走的是解压上限那条分支。
    const data = file.deflate ? deflateRawSync(raw) : raw
    const method = file.deflate ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const localFull = Buffer.concat([local, name, data])
    locals.push(localFull)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, name]))
    offset += localFull.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, eocd])
}

test('extractBookText：UTF-8 文本与 Markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '伤寒论.txt')
    writeFileSync(file, '太阳之为病，脉浮，头项强痛而恶寒。', 'utf8')
    assert.match(extractBookText(file), /太阳之为病/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractBookText：docx 解包 word/document.xml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '讲义.docx')
    const xml = '<w:document><w:body><w:p><w:r><w:t>这一条讲的是太阳病</w:t></w:r></w:p></w:body></w:document>'
    writeFileSync(file, makeZip([{ name: 'word/document.xml', data: xml }]))
    assert.match(extractBookText(file), /这一条讲的是太阳病/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractBookText：epub 读 XHTML 正文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '医案.epub')
    const html = '<html><body><p>初诊：某男，发热恶寒。</p></body></html>'
    writeFileSync(file, makeZip([{ name: 'OEBPS/ch1.xhtml', data: html }]))
    assert.match(extractBookText(file), /初诊：某男/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractBookText：PDF 读 Title 元数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, 'book.pdf')
    writeFileSync(file, Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title ('),
      Buffer.from('伤寒论', 'utf8'),
      Buffer.from(') >>\nendobj\n%%EOF\n'),
    ]))
    assert.match(extractBookText(file), /伤寒论/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractBookText：读不到的格式返回空字符串', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '旧书.doc')
    writeFileSync(file, 'not really a doc')
    assert.equal(extractBookText(file), '')
    assert.equal(extractBookText(join(dir, '不存在.pdf')), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('extractBookText：正文超过 4MB 的 docx 不能变成空', () => {
  // 回归用例：解压上限原来是 4MB，word/document.xml 一超标就抛
  // ERR_BUFFER_TOO_LARGE，被 catch 吞成空字符串，整本书只能靠书名归类。
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '长讲义.docx')
    const body = '太阳病脉证并治'.repeat(400000) // 约 5MB
    const xml = '<w:document><w:body><w:p><w:r><w:t>这一条讲的是太阳病</w:t></w:r></w:p></w:body></w:document>'
    writeFileSync(file, makeZip([{ name: 'word/document.xml', data: xml + body, deflate: true }]))
    assert.match(extractBookText(file), /这一条讲的是太阳病/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
});

test('decodeBytes：GBK 按坏字比例探测，截断的 UTF-8 不整段判死', () => {
  // 「太阳之为病，脉浮，头项强痛而恶寒。」的 GB18030 字节。
  const gbk = Buffer.from([
    0xCC, 0xAB, 0xD1, 0xF4, 0xD6, 0xAE, 0xCE, 0xAA, 0xB2, 0xA1, 0xA3, 0xAC,
    0xC2, 0xF6, 0xB8, 0xA1, 0xA3, 0xAC, 0xCD, 0xB7, 0xCF, 0xEE, 0xC7, 0xBF,
    0xCD, 0xB4, 0xB6, 0xF8, 0xB6, 0xF1, 0xBA, 0xAE, 0xA1, 0xA3,
  ])
  assert.equal(new TextDecoder('gb18030').decode(gbk), '太阳之为病，脉浮，头项强痛而恶寒。', '夹具字节先自校验')
  assert.equal(decodeBytes(gbk), '太阳之为病，脉浮，头项强痛而恶寒。')
  // UTF-8 截在字符中间：只坏结尾一个字（占比低于 2.5%），不许把整本判成 GB18030。
  const utf8 = Buffer.from('太阳之为病，脉浮，头项强痛而恶寒。'.repeat(3), 'utf8')
  const cut = utf8.subarray(0, utf8.length - 1)
  assert.ok(decodeBytes(cut).startsWith('太阳之为病'), '截断取样仍是 UTF-8 口径')
})

test('extractBookText：GBK 编码的 txt 读得出中文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '伤寒论GBK.txt')
    const gbk = Buffer.from([
      0xCC, 0xAB, 0xD1, 0xF4, 0xD6, 0xAE, 0xCE, 0xAA, 0xB2, 0xA1, 0xA3, 0xAC,
      0xC2, 0xF6, 0xB8, 0xA1, 0xA3, 0xAC, 0xCD, 0xB7, 0xCF, 0xEE, 0xC7, 0xBF,
      0xCD, 0xB4, 0xB6, 0xF8, 0xB6, 0xF1, 0xBA, 0xAE, 0xA1, 0xA3,
    ])
    writeFileSync(file, gbk)
    assert.match(extractBookText(file), /太阳之为病/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractBookText：超过 32MB 的 UTF-8 书截断取样不乱码', () => {
  // 回归用例：原来按字节硬截后 fatal UTF-8 因结尾半个字整段判死，
  // 回落 GB18030 把整本 UTF-8 书解成乱码，归类只能靠书名。
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '超大伤寒论.txt')
    const total = 32 * 1024 * 1024 + 10
    const head = Buffer.from('太阳之为病，脉浮，头项强痛而恶寒。', 'utf8')
    const fill = Buffer.from('太'.repeat(Math.ceil((total - head.length) / 3)), 'utf8')
    writeFileSync(file, Buffer.concat([head, fill]).subarray(0, total))
    const text = extractBookText(file)
    assert.match(text, /太阳之为病/, '开头正文要读得出')
    assert.ok(!text.includes('\uFFFD'), '取样窗口内不许带乱码')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractBookText：PDF 的 endstream 假标记不吞掉紧随的真 stream', () => {
  // 回归用例：字典后面先出现一个 endstream 字样，旧守卫认不出，
  // 把假标记当真 stream 去解压，失败后跳到最后一个 endstream，真正文被整个吞掉。
  const dir = mkdtempSync(join(tmpdir(), 'qh-text-'))
  try {
    const file = join(dir, '假标记.pdf')
    const content = '(ShangHanLun TaiYangBing MaiZheng BingZhi chapter one) Tj\n'.repeat(3)
    writeFileSync(file, Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /FlateDecode /Length 999 >>\nendstream\nstream'),
      deflateRawSync(content),
      Buffer.from('endstream\n%%EOF\n'),
    ]))
    assert.match(extractBookText(file), /ShangHanLun/, '真 stream 里的正文要抽得出')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
