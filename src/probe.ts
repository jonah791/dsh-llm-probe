/**
 * dsh-llm-probe · 测量装置层
 *
 * 分层（§5.34 内部三层可替换）：
 *   - 纯决策层：buildChatBody / parseChatResponse / extractNumber / stats / calibrateVerdict
 *     —— 零 I/O、零全局状态，可离线单测（tests/probe.test.mjs）
 *   - 薄 I/O 层：runProbe / calibrate —— 只做 fetch、落盘、聚合
 *
 * 三条不变量（本插件的存在理由，每条都对应一次真实事故）：
 *   1. **正文不进上下文**：模型输出写进 JSONL 落盘，工具只回读数（2026-10-11 手写 8 个一次性
 *      HTTP 脚本跑 P12a，根因就是正文会灌爆上下文）。
 *   2. **标定先于测量**：档位构成梯度是个假设，必须先证伪一次（同夜三轮实验整体作废换来的）。
 *      calibrate 的判据 noiseFloor **由调用者显式给**，本层不代填（判断不可代填）。
 *   3. **失败必须响**：端点不可达 / 响应形状不符 / 指定了凭据环境变量但它是空的
 *      —— 一律 ok:false 带原因，绝不静默返回空结果（空结果会被读成「模型答了空」）。
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// ─────────────────────────── 类型：工具面 → 本层 ───────────────────────────

export interface ProbeSpec {
  url: string
  model: string
  prompts: string[]
  system?: string
  temperature?: number
  maxTokens?: number
  reps?: number
  extract?: string
  apiKeyEnv?: string
  outDir?: string
  label?: string
}

export interface CalibBand {
  id: string
  system?: string
  temperature?: number
}

export interface CalibSpec {
  url: string
  model: string
  bands: CalibBand[]
  probes: string[]
  noiseFloor: number
  extract?: string
  maxTokens?: number
  reps?: number
  apiKeyEnv?: string
  outDir?: string
  label?: string
}

export interface Stats {
  n: number
  mean: number
  min: number
  max: number
  sd: number
}

/** 一次调用的记录（JSONL 的一行） */
interface CallRecord {
  i: number
  promptIdx: number
  rep: number
  bandId?: string
  ok: boolean
  chars: number
  latencyMs: number
  text: string
  value: number | null
  err?: string
}

// ─────────────────────────────── 纯决策层 ───────────────────────────────

/** 数值统计。空数组 ⇒ null（不编造 0——「没有数据」与「数据是 0」是两件事） */
export function stats(values: number[]): Stats | null {
  if (values.length === 0) return null
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const min = Math.min(...values)
  const max = Math.max(...values)
  const sd = n < 2 ? 0 : Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
  return { n, mean, min, max, sd }
}

/** 构造 OpenAI 兼容的 chat/completions 请求体 */
export function buildChatBody(o: {
  model: string
  system?: string
  prompt: string
  temperature: number
  maxTokens: number
}): Record<string, unknown> {
  const messages: { role: string; content: string }[] = []
  if (o.system !== undefined && o.system !== '') messages.push({ role: 'system', content: o.system })
  messages.push({ role: 'user', content: o.prompt })
  return {
    model: o.model,
    messages,
    temperature: o.temperature,
    max_tokens: o.maxTokens,
    stream: false,
  }
}

/**
 * 解析响应体。形状不符 ⇒ **抛错**（fail-loud）。
 * 只认 OpenAI 兼容形状：choices[0].message.content 是字符串。
 */
export function parseChatResponse(json: unknown): { text: string; finishReason?: string } {
  if (json === null || typeof json !== 'object') throw new Error('响应不是对象')
  const choices = (json as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('响应缺少 choices[]')
  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown }
  const content = first?.message?.content
  if (typeof content !== 'string') throw new Error('choices[0].message.content 不是字符串')
  const fr = first?.finish_reason
  return typeof fr === 'string' ? { text: content, finishReason: fr } : { text: content }
}

/** 从正文抽数值。取第一个捕获组；无捕获组则取整个匹配。无匹配 / 非数 ⇒ null */
export function extractNumber(text: string, pattern: string): number | null {
  let re: RegExp
  try {
    re = new RegExp(pattern, 'm')
  } catch {
    return null
  }
  const m = re.exec(text)
  if (m === null) return null
  const raw = m[1] ?? m[0]
  if (raw === undefined) return null
  const v = Number(raw.trim())
  return Number.isFinite(v) ? v : null
}

/**
 * 标定裁决（三态）。
 *
 * - `apparatus-down`：装置没起来 —— 零调用 / 全部调用失败 / 有数据的档位不足 2 个
 *   （⚠ 与「测不出」严格区分：这是「仪器坏了」，不是「世界如此」）
 * - `no-resolution`：有数据，但档间最大差 < noiseFloor ⇒ **测不出梯度** ⇒ 不得继续测因变量
 * - `has-resolution`：档间最大差 ≥ noiseFloor ⇒ **只证到自变量构成梯度**，因变量尚未测
 */
export function calibrateVerdict(
  perBand: { id: string; stats: Stats | null }[],
  noiseFloor: number,
  calls: number,
  failures: number,
): { verdict: 'has-resolution' | 'no-resolution' | 'apparatus-down'; disp: number | null; reason: string } {
  const withData = perBand.filter((b) => b.stats !== null)

  if (calls === 0) return { verdict: 'apparatus-down', disp: null, reason: '零调用——装置未起来' }
  if (withData.length === 0) {
    return {
      verdict: 'apparatus-down',
      disp: null,
      reason: `零有效数据（${failures}/${calls} 次调用失败）——装置未起来`,
    }
  }
  if (withData.length < 2) {
    const empty = perBand.filter((b) => b.stats === null).map((b) => b.id)
    return {
      verdict: 'apparatus-down',
      disp: null,
      reason: `只有 ${withData.length} 档有数据（空档：${empty.join('/')}）——无法比较`,
    }
  }

  const means = withData.map((b) => (b.stats as Stats).mean)
  const disp = Math.max(...means) - Math.min(...means)
  const failedNote = failures > 0 ? `（注意 ${failures}/${calls} 次调用失败，各档 n 不齐）` : ''
  if (disp < noiseFloor) {
    return {
      verdict: 'no-resolution',
      disp,
      reason: `档间最大差 ${disp} < 无分辨力线 ${noiseFloor} ⇒ 测不出档位梯度，不得继续测因变量${failedNote}`,
    }
  }
  return {
    verdict: 'has-resolution',
    disp,
    reason: `档间最大差 ${disp} ≥ 无分辨力线 ${noiseFloor} ⇒ **只证到自变量有梯度**；因变量尚未测量${failedNote}`,
  }
}

/** 落盘目录：显式 > $DSH_HOME/llm-probe > 本机默认 */
export function resolveOutDir(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env.DSH_HOME
  if (home !== undefined && home !== '') return join(home, 'llm-probe')
  return join('E:/alice/.dsh', 'llm-probe')
}

/** 内容指纹：所有正文按序拼接后的 sha256（重跑可比对——「两次读数不一致」先查输入在动没动） */
export function contentFingerprint(texts: string[]): string {
  return createHash('sha256').update(texts.join('\u0000'), 'utf8').digest('hex').slice(0, 16)
}

// ─────────────────────────────── 薄 I/O 层 ───────────────────────────────

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

function resolveKey(apiKeyEnv?: string): { key?: string; err?: string } {
  if (apiKeyEnv === undefined || apiKeyEnv === '') return {}
  const v = process.env[apiKeyEnv]
  if (v === undefined || v === '') {
    // 指定了凭据环境变量但它是空的 ⇒ 响亮失败。静默不带 key 去调，只会换来一个 401，
    // 而 401 会被读成「端点坏了」（正是那类把人带偏的假象）。
    return { err: `环境变量 ${apiKeyEnv} 未设置或为空——拒绝在无凭据的情况下调用` }
  }
  return { key: v }
}

async function callOnce(o: {
  url: string
  model: string
  system?: string
  prompt: string
  temperature: number
  maxTokens: number
  key?: string
  timeoutMs: number
}): Promise<{ ok: true; text: string; latencyMs: number } | { ok: false; err: string; latencyMs: number }> {
  const t0 = Date.now()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (o.key !== undefined) headers.authorization = `Bearer ${o.key}`
  try {
    const res = await fetch(o.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        buildChatBody({
          model: o.model,
          system: o.system,
          prompt: o.prompt,
          temperature: o.temperature,
          maxTokens: o.maxTokens,
        }),
      ),
      signal: AbortSignal.timeout(o.timeoutMs),
    })
    const raw = await res.text()
    if (!res.ok) {
      return { ok: false, err: `HTTP ${res.status}: ${raw.slice(0, 200)}`, latencyMs: Date.now() - t0 }
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return { ok: false, err: `响应不是 JSON: ${raw.slice(0, 200)}`, latencyMs: Date.now() - t0 }
    }
    const parsed = parseChatResponse(json)
    return { ok: true, text: parsed.text, latencyMs: Date.now() - t0 }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, err: `请求失败: ${msg}`, latencyMs: Date.now() - t0 }
  }
}

function readings(records: CallRecord[], o: {
  url: string
  model: string
  label: string
  outPath: string
  wallMs: number
  extract?: string
}): Record<string, unknown> {
  const okRecs = records.filter((r) => r.ok)
  const badRecs = records.filter((r) => !r.ok)

  // 全部失败 ⇒ **ok:false**（不是「ok:true 且计数为 0 成功」）。装置没起来必须是响亮的失败：
  // 回一个 ok:true 的空读数，等于把「端点不可达」伪装成「模型什么都没答」。
  // JSONL 已先落盘，证据不丢。
  if (records.length > 0 && badRecs.length === records.length) {
    return {
      ok: false,
      reason: `全部 ${records.length} 次调用失败：${badRecs[0]?.err ?? '未知'}`,
      endpoint: o.url,
      model: o.model,
      label: o.label,
      calls: records.length,
      failures: badRecs.length,
      failReasons: [...new Set(badRecs.map((r) => r.err ?? '未知'))].slice(0, 5),
      outPath: o.outPath,
      wallMs: o.wallMs,
    }
  }

  const lat = stats(okRecs.map((r) => r.latencyMs).concat(badRecs.map((r) => r.latencyMs)))
  const ch = stats(okRecs.map((r) => r.chars))
  const values = okRecs.map((r) => r.value).filter((v): v is number => v !== null)

  const out: Record<string, unknown> = {
    ok: true,
    endpoint: o.url,
    model: o.model,
    label: o.label,
    calls: records.length,
    failures: badRecs.length,
    failReasons: [...new Set(badRecs.map((r) => r.err ?? '未知'))].slice(0, 5),
    outPath: o.outPath,
    contentSha: contentFingerprint(okRecs.map((r) => r.text)),
    // 头几条正文的**截断预览**：唯一目的是让人一眼看出装置真的动了（全是空/全是同一句 ⇒ 可疑）
    samples: okRecs.slice(0, 3).map((r) => r.text.slice(0, 120)),
    uniqueOutputs: new Set(okRecs.map((r) => r.text)).size,
    wallMs: o.wallMs,
  }
  if (lat !== null) out.latencyMs = { p50: percentile(okRecs.map((r) => r.latencyMs), 50), max: lat.max }
  if (ch !== null) out.chars = { min: ch.min, max: ch.max, mean: Number(ch.mean.toFixed(2)) }
  if (o.extract !== undefined && o.extract !== '') {
    out.extracted = {
      pattern: o.extract,
      matched: values.length,
      unmatched: okRecs.length - values.length,
      stats: values.length > 0 ? roundStats(stats(values)) : null,
      values,
    }
  }
  return out
}

function roundStats(s: Stats | null): Stats | null {
  if (s === null) return null
  return {
    n: s.n,
    mean: Number(s.mean.toFixed(4)),
    min: s.min,
    max: s.max,
    sd: Number(s.sd.toFixed(4)),
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? 0
}

async function persist(dir: string, tag: string, records: CallRecord[], header: Record<string, unknown>): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${tag}.jsonl`)
  const lines = [JSON.stringify({ kind: 'header', ...header }), ...records.map((r) => JSON.stringify(r))]
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function tagOf(label: string | undefined, prefix: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = (label ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  return safe === '' ? `${prefix}-${ts}` : `${prefix}-${safe}-${ts}`
}

const DEFAULT_TIMEOUT_MS = 60_000

/** 跑一批 prompt（× reps），只回读数 */
export async function runProbe(spec: ProbeSpec): Promise<Record<string, unknown>> {
  if (spec.url === undefined || spec.url === '') return fail('url 必填（本工具无默认端点）')
  if (spec.model === undefined || spec.model === '') return fail('model 必填')
  if (!Array.isArray(spec.prompts) || spec.prompts.length === 0) return fail('prompts 必填且非空')
  // 边界校验（同 calibrate 的理由）：数组元素来自 DSL，是 JsonValue 不是 string。
  if ((spec.prompts as unknown[]).some((p) => typeof p !== 'string')) return fail('prompts 每项必须是字符串')

  const keyInfo = resolveKey(spec.apiKeyEnv)
  if (keyInfo.err !== undefined) return fail(keyInfo.err)

  const reps = Math.max(1, Math.floor(spec.reps ?? 1))
  const temperature = spec.temperature ?? 0
  const maxTokens = spec.maxTokens ?? 8
  const t0 = Date.now()
  const records: CallRecord[] = []

  let i = 0
  for (let p = 0; p < spec.prompts.length; p++) {
    const prompt = spec.prompts[p] ?? ''
    for (let rep = 0; rep < reps; rep++) {
      const r = await callOnce({
        url: spec.url,
        model: spec.model,
        system: spec.system,
        prompt,
        temperature,
        maxTokens,
        key: keyInfo.key,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      })
      records.push({
        i: i++,
        promptIdx: p,
        rep,
        ok: r.ok,
        chars: r.ok ? r.text.length : 0,
        latencyMs: r.latencyMs,
        text: r.ok ? r.text : '',
        value: r.ok && spec.extract !== undefined && spec.extract !== '' ? extractNumber(r.text, spec.extract) : null,
        ...(r.ok ? {} : { err: r.err }),
      })
    }
  }

  const dir = resolveOutDir(spec.outDir)
  const label = spec.label ?? ''
  const outPath = await persist(dir, tagOf(spec.label, 'llmprobe-run'), records, {
    url: spec.url,
    model: spec.model,
    temperature,
    maxTokens,
    reps,
    prompts: spec.prompts.length,
    system: spec.system ?? null,
    extract: spec.extract ?? null,
  })

  return readings(records, { url: spec.url, model: spec.model, label, outPath, wallMs: Date.now() - t0, extract: spec.extract })
}

/** 标定：每档一个条件，跑同一批探针 ⇒ 三态裁决 */
export async function calibrate(spec: CalibSpec): Promise<Record<string, unknown>> {
  if (spec.url === undefined || spec.url === '') return fail('url 必填（本工具无默认端点）')
  if (spec.model === undefined || spec.model === '') return fail('model 必填')
  if (!Array.isArray(spec.bands) || spec.bands.length < 2) return fail('bands 至少 2 档（只有一档无从比较）')
  if (!Array.isArray(spec.probes) || spec.probes.length === 0) return fail('probes 必填且非空')
  if (typeof spec.noiseFloor !== 'number' || !Number.isFinite(spec.noiseFloor)) {
    return fail('noiseFloor 必填且须为有限数——判据由调用者定，工具不代填')
  }

  // 入参来自工具面的 DSL（数组元素是 JsonValue，不是 CalibBand）⇒ 边界校验必须在这一层做
  // （§5.30 边界诚实）。形状不符即拒，不让半个对象混进来污染读数。
  for (const raw of spec.bands as unknown[]) {
    const b = raw as { id?: unknown; system?: unknown; temperature?: unknown } | null
    if (b === null || typeof b !== 'object' || typeof b.id !== 'string' || b.id === '') {
      return fail('bands 每项必须是对象且带非空字符串 id（形如 {"id":"low","system":"…"}）')
    }
    if (b.system !== undefined && typeof b.system !== 'string') return fail(`band ${b.id}: system 必须是字符串`)
    if (b.temperature !== undefined && (typeof b.temperature !== 'number' || !Number.isFinite(b.temperature))) {
      return fail(`band ${b.id}: temperature 必须是有限数`)
    }
  }
  if ((spec.probes as unknown[]).some((p) => typeof p !== 'string')) return fail('probes 每项必须是字符串')

  const keyInfo = resolveKey(spec.apiKeyEnv)
  if (keyInfo.err !== undefined) return fail(keyInfo.err)

  const reps = Math.max(1, Math.floor(spec.reps ?? 1))
  const maxTokens = spec.maxTokens ?? 8
  const t0 = Date.now()
  const records: CallRecord[] = []

  let i = 0
  for (const band of spec.bands) {
    const temperature = band.temperature ?? 0
    for (let p = 0; p < spec.probes.length; p++) {
      const prompt = spec.probes[p] ?? ''
      for (let rep = 0; rep < reps; rep++) {
        const r = await callOnce({
          url: spec.url,
          model: spec.model,
          system: band.system,
          prompt,
          temperature,
          maxTokens,
          key: keyInfo.key,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        })
        records.push({
          i: i++,
          promptIdx: p,
          rep,
          bandId: band.id,
          ok: r.ok,
          chars: r.ok ? r.text.length : 0,
          latencyMs: r.latencyMs,
          text: r.ok ? r.text : '',
          value: r.ok && spec.extract !== undefined && spec.extract !== '' ? extractNumber(r.text, spec.extract) : null,
          ...(r.ok ? {} : { err: r.err }),
        })
      }
    }
  }

  const perBand = spec.bands.map((b) => {
    const vals = records
      .filter((r) => r.bandId === b.id && r.ok)
      .map((r) => r.value)
      .filter((v): v is number => v !== null)
    return { id: b.id, stats: stats(vals) }
  })

  const failures = records.filter((r) => !r.ok).length
  const verdict = calibrateVerdict(perBand, spec.noiseFloor, records.length, failures)

  const dir = resolveOutDir(spec.outDir)
  const label = spec.label ?? ''
  const outPath = await persist(dir, tagOf(spec.label, 'llmprobe-calib'), records, {
    url: spec.url,
    model: spec.model,
    maxTokens,
    reps,
    bands: spec.bands.map((b) => b.id),
    probes: spec.probes.length,
    noiseFloor: spec.noiseFloor,
    extract: spec.extract ?? null,
  })

  const base = readings(records, { url: spec.url, model: spec.model, label, outPath, wallMs: Date.now() - t0, extract: spec.extract })
  return {
    ...base,
    noiseFloor: spec.noiseFloor,
    perBand: perBand.map((b) => ({ id: b.id, stats: roundStats(b.stats) })),
    // disp 为 null 时**省略该字段**（而不是回 null）——输出的 schema 里 number 类型不收 null，
    // 而「装置没起来」本来就该是「没有这个读数」，不是「读数是 null」。
    ...(verdict.disp !== null ? { disp: verdict.disp } : {}),
    verdict: verdict.verdict,
    verdictReason: verdict.reason,
  }
}
