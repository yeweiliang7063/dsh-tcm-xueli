// 学理模式：随包资料的单元测试
// 验证只补书、不补规程，以及五个分类文件夹的建立。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureCorpus } from '../lib/corpus.js'
import { ensureCategoryDirs } from '../lib/kb-index.js'

test('ensureCorpus：把十部经典补到 text/，第二次不重复复制', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-corpus-'))
  const first = ensureCorpus(kb)
  assert.ok(first >= 10, `应至少复制 10 个文件，实际 ${first}`)
  assert.ok(fs.existsSync(path.join(kb, 'text', '03-伤寒论.md')))
  assert.ok(fs.existsSync(path.join(kb, 'text', '07-濒湖脉学.md')))
  // 本草原本随包；今人注本有版权，不随包
  assert.ok(fs.existsSync(path.join(kb, 'text', '10-神农本草经.md')))
  assert.equal(fs.existsSync(path.join(kb, 'text', '11-神农本草经倪海厦注.txt')), false)
  assert.equal(ensureCorpus(kb), 0)
})

test('ensureCorpus：资料库里已有同名文件时不覆盖', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-corpus-'))
  const target = path.join(kb, 'text', '03-伤寒论.md')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '我自己整理的版本', 'utf8')
  ensureCorpus(kb)
  assert.equal(fs.readFileSync(target, 'utf8'), '我自己整理的版本')
})

test('ensureCategoryDirs：建五个分类文件夹，第二次不重复', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-category-'))
  assert.equal(ensureCategoryDirs(kb), 5)
  for (const name of ['经典', '经典注解', '名著', '医案', '方药']) {
    assert.ok(fs.statSync(path.join(kb, name)).isDirectory(), `应建立 ${name}/`)
  }
  assert.equal(ensureCategoryDirs(kb), 0)
})

test('ensureCategoryDirs：资料库不存在时返回 0，不擅自建根目录', () => {
  const kb = path.join(os.tmpdir(), `tcm-category-missing-${Date.now()}`)
  assert.equal(ensureCategoryDirs(kb), 0)
  assert.equal(fs.existsSync(kb), false)
})

test('ensureCorpus：单本复制失败要记日志，不静默吞', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-corpus-fail-'))
  // 用一个目录占住书名：rename 到目录必然失败，模拟写入失败。
  fs.mkdirSync(path.join(kb, 'text', '03-伤寒论.md'), { recursive: true })
  const warns = []
  const copied = ensureCorpus(kb, { warn: (...args) => warns.push(args) })
  assert.ok(copied >= 9, `其它书照常补，实际 ${copied}`)
  assert.ok(warns.length >= 1, '失败必须记日志')
  assert.ok(fs.statSync(path.join(kb, 'text', '03-伤寒论.md')).isDirectory(), '失败不碰用户既有路径')
})

test('ensureCorpus：text 目录建失败时记日志并返回 0', () => {
  const kb = path.join(os.tmpdir(), `tcm-corpus-file-${Date.now()}`)
  fs.writeFileSync(kb, '占位', 'utf8')
  const warns = []
  assert.equal(ensureCorpus(kb, { warn: (...args) => warns.push(args) }), 0)
  assert.ok(warns.length >= 1, 'mkdir 失败必须记日志')
})

test('ensureCategoryDirs：建失败无日志通道时返回 -1，有日志时逐条 warn', () => {
  const kb = path.join(os.tmpdir(), `tcm-category-file-${Date.now()}`)
  fs.writeFileSync(kb, '占位', 'utf8')
  assert.equal(ensureCategoryDirs(kb), -1, '没有日志通道要如实返回失败')
  const warns = []
  assert.equal(ensureCategoryDirs(kb, { warn: (...args) => warns.push(args) }), 0)
  assert.equal(warns.length, 5, '五个文件夹各记一条')
})