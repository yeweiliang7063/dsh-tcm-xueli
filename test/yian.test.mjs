// 医案浏览通道：只读列出/读取资料库 医案/ 的 .md；basename 闸＋库根复查＋本机页面门卫。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listYian, mountYianRoute, parseFrontmatter, readYian, safeYianName } from '../lib/yian.js'
import { RECORD_DIR } from '../lib/records.js'

function makeKb() {
  const kb = mkdtempSync(join(tmpdir(), 'dsh-yian-'))
  mkdirSync(join(kb, RECORD_DIR), { recursive: true })
  return kb
}

function putYian(kb, name, title, body, mtime) {
  const text = [
    '---',
    `标题: ${JSON.stringify(title)}`,
    '会话: "session-x"',
    '预设: "dsh-tcm-xueli"',
    '创建: "2026年11月23日 10:00"',
    '更新: "2026年11月23日 11:00"',
    '来源: "中医 · 经方自动记录"',
    '---',
    '',
    `# ${title}`,
    '',
    '## 对话',
    '',
    body,
    '',
  ].join('\n')
  const file = join(kb, RECORD_DIR, name)
  writeFileSync(file, text, 'utf8')
  if (mtime) utimesSync(file, mtime, mtime)
  return file
}

test('parseFrontmatter：拆元信息与正文；没有 frontmatter 原样回正文', () => {
  const { meta, body } = parseFrontmatter('---\n标题: "桂枝汤"\n创建: "昨天"\n---\n\n# 桂枝汤\n\n正文')
  assert.equal(meta['标题'], '桂枝汤')
  assert.equal(meta['创建'], '昨天')
  assert.equal(body, '# 桂枝汤\n\n正文')
  const plain = parseFrontmatter('# 没有元信息\n\n正文')
  assert.deepEqual(plain.meta, {})
  assert.equal(plain.body, '# 没有元信息\n\n正文')
})

test('safeYianName：只认 basename 的 .md，路径符号/./../非 .md 一律拒', () => {
  assert.equal(safeYianName('桂枝汤.md'), true)
  assert.equal(safeYianName('a.md'), true)
  assert.equal(safeYianName('../x.md'), false)
  assert.equal(safeYianName('a/b.md'), false)
  assert.equal(safeYianName('a\\b.md'), false)
  assert.equal(safeYianName('..'), false)
  assert.equal(safeYianName('.'), false)
  assert.equal(safeYianName('x.txt'), false)
  assert.equal(safeYianName(''), false)
  assert.equal(safeYianName(null), false)
  assert.equal(safeYianName('x'.repeat(201) + '.md'), false)
})

test('listYian：列 .md、按修改时间新的在前、标题取 frontmatter；非 .md 与子目录不混进来', () => {
  const kb = makeKb()
  putYian(kb, '旧.md', '旧医案', '### 用户\n\n旧', new Date('2026-11-20T10:00:00'))
  putYian(kb, '新.md', '新医案', '### 用户\n\n新', new Date('2026-11-23T10:00:00'))
  writeFileSync(join(kb, RECORD_DIR, '笔记.txt'), '不是医案', 'utf8')
  mkdirSync(join(kb, RECORD_DIR, '子目录'), { recursive: true })
  const list = listYian(kb)
  assert.deepEqual(list.map((x) => x.file), ['新.md', '旧.md'])
  assert.equal(list[0].title, '新医案')
  assert.equal(list[1].title, '旧医案')
  assert.ok(list[0].at >= list[1].at)
  assert.deepEqual(listYian(join(kb, '不存在')), [])
})

test('readYian：读标题/时间/正文；穿越/非 .md/不在的文件一律拒', () => {
  const kb = makeKb()
  putYian(kb, '桂枝汤.md', '桂枝汤证', '### 用户\n\n头疼。\n\n### 中医 · 经方\n\n桂枝*。')
  const got = readYian(kb, '桂枝汤.md')
  assert.equal(got.ok, true)
  assert.equal(got.title, '桂枝汤证')
  assert.equal(got.created, '2026年11月23日 10:00')
  assert.ok(got.body.includes('### 用户'))
  assert.ok(got.body.includes('桂枝*。'))
  assert.ok(!got.body.startsWith('---'), 'frontmatter 不该混进正文')
  for (const bad of ['../桂枝汤.md', '子目录/桂枝汤.md', '..', '桂枝汤.txt', '不在.md', 'a\\b.md']) {
    assert.equal(readYian(kb, bad).ok, false, '不该读出来：' + bad)
  }
  assert.equal(readYian('', '桂枝汤.md').ok, false)
})

test('readYian：库根外的同名文件读不到（库根复查）', () => {
  const kb = makeKb()
  // 在资料库根放一份同名 .md（不在 医案/ 里），readYian 只认 医案/ 里的，读不到根上这份。
  writeFileSync(join(kb, '根上.md'), '---\n标题: "根上"\n---\n\n# 根上', 'utf8')
  assert.equal(readYian(kb, '根上.md').ok, false)
})

/** 假 Web 服务／请求／响应（与 teach.test 同一套）。 */
function fakeWeb() {
  const routes = []
  return { register(o) { routes.push(o); return () => {} }, routes }
}
function fakeReq(method, url, remoteAddress = '127.0.0.1', extraHeaders = {}) {
  return { method, url, headers: { host: '127.0.0.1:64368', 'sec-fetch-site': 'same-origin', ...extraHeaders }, socket: { remoteAddress, localAddress: '127.0.0.1' } }
}
function fakeRes() {
  const out = { code: 0, body: '' }
  return { out, writeHead(code) { out.code = code }, end(body) { if (body) out.body = body } }
}
async function ask(handler, req) {
  const res = fakeRes()
  handler(req, res)
  await new Promise((r) => setTimeout(r, 10))
  return { code: res.out.code, json: res.out.body ? JSON.parse(res.out.body) : null }
}

test('浏览通道：GET 列表与读单份；POST/远程/外站页面一律挡', async () => {
  const kb = makeKb()
  putYian(kb, '桂枝汤.md', '桂枝汤证', '### 用户\n\n头疼。')
  const web = fakeWeb()
  const dispose = await mountYianRoute({ get: (n) => (n === 'webServer' ? web : undefined) }, { rootDir: () => kb })
  assert.equal(typeof dispose, 'function')
  assert.equal(web.routes.length, 1)
  const handler = web.routes[0].handler

  const list = await ask(handler, fakeReq('GET', '/dsh-tcm-xueli/yian'))
  assert.equal(list.code, 200)
  assert.equal(list.json.ok, true)
  assert.deepEqual(list.json.files.map((x) => x.file), ['桂枝汤.md'])

  const one = await ask(handler, fakeReq('GET', '/dsh-tcm-xueli/yian?file=' + encodeURIComponent('桂枝汤.md')))
  assert.equal(one.code, 200)
  assert.equal(one.json.ok, true)
  assert.equal(one.json.title, '桂枝汤证')

  assert.equal((await ask(handler, fakeReq('POST', '/dsh-tcm-xueli/yian'))).code, 405)
  assert.equal((await ask(handler, fakeReq('GET', '/dsh-tcm-xueli/yian', '10.0.0.7'))).code, 403)
  assert.equal((await ask(handler, fakeReq('GET', '/dsh-tcm-xueli/yian', '127.0.0.1', { origin: 'https://evil.example.com' }))).code, 403)
  assert.equal((await ask(handler, fakeReq('GET', '/dsh-tcm-xueli/yian', '127.0.0.1', { referer: 'https://evil.example.com/p.html' }))).code, 403)
  assert.equal((await ask(handler, fakeReq('GET', '/dsh-tcm-xueli/yian', '127.0.0.1', { origin: 'http://127.0.0.1:64368' }))).code, 200)
  // 穿越文件名在通道层也被读不出来。
  const bad = await ask(handler, fakeReq('GET', '/dsh-tcm-xueli/yian?file=' + encodeURIComponent('../桂枝汤.md')))
  assert.equal(bad.json.ok, false)
})

test('浏览通道：资料库没设时回 ok:false 不抛', async () => {
  const web = fakeWeb()
  await mountYianRoute({ get: (n) => (n === 'webServer' ? web : undefined) }, { rootDir: () => '' })
  const got = await ask(web.routes[0].handler, fakeReq('GET', '/dsh-tcm-xueli/yian'))
  assert.equal(got.code, 200)
  assert.equal(got.json.ok, false)
  assert.deepEqual(got.json.files, [])
})