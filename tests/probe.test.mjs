/**
 * dsh-llm-probe 单测 —— 纯层全离线（零网络），I/O 层用**尸体样本**（死端点）证明它会响。
 *
 * 判据纪律：恒为绿的判据不是证据。故本文既有金标准（正常输入走通），
 * 也有尸体（坏输入必须被拦：形状不符 / 全部失败 / 只有一档有数据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  stats,
  buildChatBody,
  parseChatResponse,
  extractNumber,
  calibrateVerdict,
  contentFingerprint,
  resolveOutDir,
  runProbe,
  calibrate,
} from '../lib/probe.js'

const DEAD = 'http://127.0.0.1:1/v1/chat/completions'

async function tmp() {
  return await mkdtemp(join(tmpdir(), 'llmprobe-test-'))
}

// ───────────────────────── 纯层：金标准 ─────────────────────────

test('stats：已知值可复算；空数组 ⇒ null（不编造 0）', () => {
  const s = stats([1, 2, 3, 4])
  assert.equal(s.n, 4)
  assert.equal(s.mean, 2.5)
  assert.equal(s.min, 1)
  assert.equal(s.max, 4)
  assert.ok(Math.abs(s.sd - Math.sqrt(5 / 3)) < 1e-12)
  assert.equal(stats([]), null)
})

test('buildChatBody：有/无 system 两形态；temperature/max_tokens 透传', () => {
  const withSys = buildChatBody({ model: 'm', system: 'S', prompt: 'P', temperature: 0, maxTokens: 8 })
  assert.deepEqual(withSys.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'P' },
  ])
  assert.equal(withSys.temperature, 0)
  assert.equal(withSys.max_tokens, 8)
  assert.equal(withSys.stream, false)

  const noSys = buildChatBody({ model: 'm', prompt: 'P', temperature: 0.5, maxTokens: 16 })
  assert.deepEqual(noSys.messages, [{ role: 'user', content: 'P' }])
  // 空串 system 也不该产出空 system 消息
  const emptySys = buildChatBody({ model: 'm', system: '', prompt: 'P', temperature: 0, maxTokens: 8 })
  assert.equal(emptySys.messages.length, 1)
})

test('parseChatResponse：正常形状取到 text 与 finish_reason', () => {
  const r = parseChatResponse({ choices: [{ message: { content: '5' }, finish_reason: 'stop' }] })
  assert.equal(r.text, '5')
  assert.equal(r.finishReason, 'stop')
})

test('extractNumber：捕获组 / 无捕获组 / 无匹配 / 非数值', () => {
  assert.equal(extractNumber('分数：7 分', '分数：(\\d+)'), 7)
  assert.equal(extractNumber('7', '\\d+'), 7)
  assert.equal(extractNumber('没有数字', '\\d+'), null)
  assert.equal(extractNumber('abc', '分数：(\\d+)'), null)
  // 非数值捕获组 ⇒ null（不能变成 NaN 混进统计）
  assert.equal(extractNumber('x=abc', 'x=(\\w+)'), null)
})

test('contentFingerprint：同输入同指纹、异输入异指纹（重跑可比对）', () => {
  assert.equal(contentFingerprint(['a', 'b']), contentFingerprint(['a', 'b']))
  assert.notEqual(contentFingerprint(['a', 'b']), contentFingerprint(['ab']))
  assert.equal(contentFingerprint([]).length, 16)
})

test('resolveOutDir：显式 > $DSH_HOME/llm-probe', () => {
  assert.equal(resolveOutDir('D:/x'), 'D:/x')
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = 'E:/fake-home'
  try {
    assert.equal(resolveOutDir(), join('E:/fake-home', 'llm-probe'))
    assert.equal(resolveOutDir(''), join('E:/fake-home', 'llm-probe'))
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})

// ───────────────────── 纯层：三态裁决（五个分支逐个走） ─────────────────────

test('calibrateVerdict：三态五分支', () => {
  const s = (mean) => ({ n: 3, mean, min: mean, max: mean, sd: 0 })

  // ① 零调用 ⇒ 装置没起来
  assert.equal(calibrateVerdict([], 0.5, 0, 0).verdict, 'apparatus-down')

  // ② 全部失败（零有效数据）⇒ 装置没起来
  assert.equal(calibrateVerdict([{ id: 'a', stats: null }, { id: 'b', stats: null }], 0.5, 6, 6).verdict, 'apparatus-down')

  // ③ 只有一档有数据 ⇒ 无法比较 ⇒ 装置没起来（不是「无分辨力」）
  const one = calibrateVerdict([{ id: 'a', stats: s(3) }, { id: 'b', stats: null }], 0.5, 6, 3)
  assert.equal(one.verdict, 'apparatus-down')
  assert.match(one.reason, /b/)

  // ④ 有数据但档间差 < 线 ⇒ 无分辨力（不得继续测因变量）
  const nr = calibrateVerdict([{ id: 'a', stats: s(3.0) }, { id: 'b', stats: s(3.3) }], 0.5, 6, 0)
  assert.equal(nr.verdict, 'no-resolution')
  assert.ok(Math.abs(nr.disp - 0.3) < 1e-9)

  // ⑤ 档间差 ≥ 线 ⇒ 有分辨力（且必须写明「因变量尚未测」）
  const hr = calibrateVerdict([{ id: 'a', stats: s(3.0) }, { id: 'b', stats: s(3.9) }], 0.5, 6, 0)
  assert.equal(hr.verdict, 'has-resolution')
  assert.match(hr.reason, /因变量尚未测量/)

  // 边界：恰好等于线 ⇒ 算有分辨力（判据是 < 线才判无）
  assert.equal(calibrateVerdict([{ id: 'a', stats: s(3.0) }, { id: 'b', stats: s(3.5) }], 0.5, 6, 0).verdict, 'has-resolution')

  // 部分失败 ⇒ 不改变裁决，但必须披露 n 不齐
  assert.match(calibrateVerdict([{ id: 'a', stats: s(3.0) }, { id: 'b', stats: s(3.9) }], 0.5, 6, 2).reason, /不齐/)
})

// ───────────────────────── 纯层：尸体样本 ─────────────────────────

test('尸体 · parseChatResponse：形状不符必须抛错（不是静默返回空串）', () => {
  assert.throws(() => parseChatResponse(null), /不是对象/)
  assert.throws(() => parseChatResponse({}), /choices/)
  assert.throws(() => parseChatResponse({ choices: [] }), /choices/)
  assert.throws(() => parseChatResponse({ choices: [{}] }), /content/)
  assert.throws(() => parseChatResponse({ choices: [{ message: { content: 123 } }] }), /content/)
})

// ───────────────────────── 参数守卫（纯本地，零网络） ─────────────────────────

test('runProbe 参数守卫：缺 url/model/prompts 一律 ok:false 带原因', async () => {
  const r1 = await runProbe({ url: '', model: 'm', prompts: ['p'] })
  assert.equal(r1.ok, false)
  assert.match(r1.reason, /url/)

  const r2 = await runProbe({ url: 'http://x', model: '', prompts: ['p'] })
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /model/)

  const r3 = await runProbe({ url: 'http://x', model: 'm', prompts: [] })
  assert.equal(r3.ok, false)
  assert.match(r3.reason, /prompts/)
})

test('尸体 · 指定了凭据环境变量但它是空的 ⇒ 拒绝调用（不静默裸调换来一个 401）', async () => {
  delete process.env.LLMPROBE_TEST_MISSING_KEY
  const r = await runProbe({ url: 'http://127.0.0.1:1/x', model: 'm', prompts: ['p'], apiKeyEnv: 'LLMPROBE_TEST_MISSING_KEY' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /LLMPROBE_TEST_MISSING_KEY/)
  assert.match(r.reason, /未设置或为空/)
})

test('calibrate 参数守卫：档位不足 2 / noiseFloor 缺失 ⇒ 拒绝（判据不可代填）', async () => {
  const r1 = await calibrate({ url: 'http://x', model: 'm', bands: [{ id: 'a' }], probes: ['p'], noiseFloor: 0.5 })
  assert.equal(r1.ok, false)
  assert.match(r1.reason, /bands/)

  const r2 = await calibrate({ url: 'http://x', model: 'm', bands: [{ id: 'a' }, { id: 'b' }], probes: ['p'] })
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /noiseFloor/)
})

// ───────────────────────── I/O 层：尸体（死端点） ─────────────────────────

test('尸体 · runProbe 对死端点：ok:false 且 JSONL 仍落盘（证据不丢）', async () => {
  const dir = await tmp()
  const r = await runProbe({ url: DEAD, model: 'm', prompts: ['p1', 'p2'], outDir: dir, label: 'corpse' })
  assert.equal(r.ok, false, '全部失败必须 ok:false——不能把「端点不可达」伪装成「模型答了空」')
  assert.match(r.reason, /全部 2 次调用失败/)
  assert.equal(r.calls, 2)
  assert.equal(r.failures, 2)
  assert.ok(r.failReasons.length >= 1)
  const body = await readFile(r.outPath, 'utf8')
  const lines = body.trim().split('\n')
  assert.equal(lines.length, 3, 'header + 2 条调用记录')
  assert.equal(JSON.parse(lines[0]).kind, 'header')
  assert.equal(JSON.parse(lines[1]).ok, false)
})

test('尸体 · calibrate 对死端点：ok:false 且裁决为 apparatus-down（三态机不是恒绿）', async () => {
  const dir = await tmp()
  const r = await calibrate({
    url: DEAD,
    model: 'm',
    bands: [{ id: 'lo', system: 'a' }, { id: 'hi', system: 'b' }],
    probes: ['p1'],
    noiseFloor: 0.5,
    outDir: dir,
    label: 'corpse-calib',
  })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'apparatus-down')
  assert.match(r.verdictReason, /装置未起来/)
  assert.equal(r.disp, undefined, '装置没起来时不该有 disp 读数')
})
