import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addPending,
  dshHome,
  dropPending,
  findSessionDirs,
  purgeSession,
  readPending,
  sweepPending,
} from '../lib/purge.js'

/** 造一个「DSH 家目录」：sessions/<工作区>/<会话号>/session.v4.jsonl.zstd */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-purge-'))
  return home
}

function makeSession(home, workspace, id) {
  const dir = join(home, 'sessions', workspace, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
  return dir
}

function fakeCtx(registry) {
  return { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
}

function fakeRegistry(ids) {
  const archived = []
  const ws = {
    id: 'w1',
    sessionIds: [...ids],
    mutate: async (fn) => {
      const next = fn({ id: 'w1', sessionIds: [...ws.sessionIds] })
      ws.sessionIds = next.sessionIds
      return next
    },
  }
  return {
    archived,
    list: () => [ws],
    archiveSession: async (id) => { archived.push(id) },
  }
}

test('会话目录按「工作区/会话号」找得到，没有的就不列', () => {
  const home = makeHome()
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = makeSession(home, 'ws-a', 's-1')
    makeSession(home, 'ws-b', 's-1')
    makeSession(home, 'ws-a', 's-2')
    const found = findSessionDirs('s-1', home)
    assert.equal(found.length, 2)
    assert.ok(found.includes(dir))
    assert.deepEqual(findSessionDirs('s-404', home), [])
  } finally {
    process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('删一局：先归档、再从工作区名册摘掉、最后删目录', async () => {
  const home = makeHome()
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = makeSession(home, 'ws-a', 's-del')
    const registry = fakeRegistry(['s-del', 's-keep'])
    const result = await purgeSession(fakeCtx(registry), 's-del')
    assert.deepEqual(registry.archived, ['s-del'], '删之前先归档')
    assert.deepEqual(registry.list()[0].sessionIds, ['s-keep'], '名册里不再有它')
    assert.equal(existsSync(dir), false, '目录真的删掉了')
    assert.deepEqual(result.removed.length, 1)
  } finally {
    process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('看不懂的会话号一律不删', async () => {
  const registry = fakeRegistry([])
  const result = await purgeSession(fakeCtx(registry), '../etc/passwd')
  assert.equal(result.ok, false)
  assert.deepEqual(registry.archived, [])
})

test('待清名单：记一条、读得回、清得掉', () => {
  const home = makeHome()
  try {
    assert.deepEqual(readPending(home), [])
    assert.equal(addPending('s-a', home), true)
    addPending('s-b', home)
    addPending('s-a', home)
    assert.deepEqual(readPending(home), ['s-b', 's-a'], '同一个号不重复记')
    assert.equal(dropPending('s-b', home), true)
    assert.deepEqual(readPending(home), ['s-a'])
    assert.equal(dropPending('s-404', home), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('启动补刀：名单上的局删掉、名单清空', async () => {
  const home = makeHome()
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = makeSession(home, 'ws-a', 's-pending')
    const registry = fakeRegistry(['s-pending'])
    addPending('s-pending', home)
    const done = await sweepPending(fakeCtx(registry), home)
    assert.equal(done, 1)
    assert.deepEqual(readPending(home), [])
    assert.equal(existsSync(dir), false)
  } finally {
    process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('默认家目录就是 ~/.dsh（可用 DSH_HOME 覆盖）', () => {
  const old = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.ok(dshHome().endsWith('.dsh'))
    process.env.DSH_HOME = 'D:/tmp-home'
    assert.equal(dshHome(), 'D:/tmp-home')
  } finally {
    process.env.DSH_HOME = old
  }
})
test('摘名册：宿主有公开的 detachSession 就先走它，不碰内部的 mutate', async () => {
  const home = makeHome()
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    makeSession(home, 'ws-a', 's-pub')
    const calls = []
    const ws = {
      id: 'w1',
      sessionIds: ['s-pub'],
      detachSession: async (id) => {
        calls.push('detach:' + id)
        ws.sessionIds = ws.sessionIds.filter((one) => one !== id)
      },
      mutate: async () => { calls.push('mutate'); return {} },
    }
    const registry = { archived: [], list: () => [ws], archiveSession: async (id) => { registry.archived.push(id) } }
    const result = await purgeSession(fakeCtx(registry), 's-pub')
    assert.deepEqual(calls, ['detach:s-pub'], '有公开接口就走公开接口')
    assert.deepEqual(ws.sessionIds, [])
    assert.equal(result.ok, true)
  } finally {
    process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('投影缓存：一局一个文件的目录结构，删完不留空壳标题', async () => {
  const home = makeHome()
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    const mine = join(dir, 's-pc.json')
    const other = join(dir, 's-keep.json')
    writeFileSync(mine, '{"version":7}')
    writeFileSync(other, '{"version":7}')
    makeSession(home, 'ws-a', 's-pc')

    await purgeSession(fakeCtx(fakeRegistry(['s-pc'])), 's-pc')
    assert.equal(existsSync(mine), false, '这一局的标题条目要清掉')
    assert.equal(existsSync(other), true, '别的局的标题条目一下都不许碰')
  } finally {
    process.env.DSH_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})
