/**
 * 出口遮挡：克数之外，针法深度、留针时长、灸壮数、剂数也一并遮掉。
 * 经典原文里的两／钱／枚照原样，不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blotDosage, hasDosage } from '../lib/dosage-guard.js'

test('针法、灸法、剂数：刺入深度、留针时长、灸壮数、几剂都遮', () => {
  assert.equal(blotDosage('直刺 1.5 寸，留针 30 分钟'), '直刺 *，留针 *')
  assert.equal(blotDosage('斜刺0.5～0.8寸'), '斜刺*')
  assert.equal(blotDosage('艾灸 5 壮'), '艾灸 *')
  assert.equal(blotDosage('共 7 剂'), '共 *')
})

test('寸口脉、分寸这类说法不误伤', () => {
  assert.equal(hasDosage('寸口脉浮'), false)
  assert.equal(hasDosage('做事有分寸'), false)
  assert.equal(blotDosage('寸口脉浮'), '寸口脉浮')
})

test('经典计量照原样，两、钱、枚不遮', () => {
  assert.equal(blotDosage('桂枝三两，芍药三两'), '桂枝三两，芍药三两')
  assert.equal(blotDosage('大枣十二枚'), '大枣十二枚')
})
test('现代医嘱：日几服、针几分也遮；古文煎服法照旧', () => {
  assert.equal(blotDosage('日三服'), '日*')
  assert.equal(blotDosage('分温三服'), '分温*')
  assert.equal(blotDosage('每日三次'), '每日*')
  assert.equal(blotDosage('针三分'), '针*')
  assert.equal(blotDosage('留针十分钟'), '留针*')
  assert.equal(blotDosage('灸3壮'), '灸*')
  assert.equal(blotDosage('留针十分必要'), '留针十分必要', '「十分」不是时长')
  assert.equal(blotDosage('桂枝汤：桂枝三两，芍药三两，分温三服'), '桂枝汤：桂枝三两，芍药三两，分温三服', '带古制单位的原文不遮')
})
