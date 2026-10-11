/**
 * dsh-llm-probe：把任意 OpenAI 兼容端点当测量装置跑实验 —— 直连通话 · 只回读数 · 标定先于测量 · 失败必须响
 *
 * 决策逻辑全在 `./probe.ts`（纯层可离线单测），本文件只是工具面（薄壳）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runProbe, calibrate, type ProbeSpec, type CalibSpec } from './probe.js'

export const name = 'agent-llm-probe'
export const inject = ['tools'] as const

export interface Config {
  enabled: boolean
}
export const Config = z.object({
  enabled: z.boolean().default(true),
})

/**
 * 读数契约（`readings()` 的返回值 + calibrate 的四个附加字段）。
 *
 * `additionalProperties: true` 与 `type` 上的 `as any` 都是**有意**的：
 *   - 读数会随实验形态长出新的聚合字段，而 output.schema 是**严格**校验——多一个未声明字段
 *     整条工具调用就作废。宁可松一格，也不要因为加了个读数就把工具打死。
 *   - 工具 schema 是**数据不是逻辑**，这一行是本文件与 dsh-tools 的 ValueSchemaSpec 类型的显式边界
 *     （§5.30 边界诚实）：本地 schema 比该类型更宽（允许额外属性），类型系统表达不了。
 * 已声明的 21 个字段是契约的**下限**，不是上限。
 */
const READINGS_SCHEMA: any = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    reason: { type: 'string' },
    endpoint: { type: 'string' },
    model: { type: 'string' },
    label: { type: 'string' },
    calls: { type: 'number' },
    failures: { type: 'number' },
    failReasons: { type: 'array' },
    outPath: { type: 'string' },
    contentSha: { type: 'string' },
    samples: { type: 'array' },
    uniqueOutputs: { type: 'number' },
    wallMs: { type: 'number' },
    latencyMs: { type: 'object', additionalProperties: true },
    chars: { type: 'object', additionalProperties: true },
    extracted: { type: 'object', additionalProperties: true },
    noiseFloor: { type: 'number' },
    perBand: { type: 'array' },
    disp: { type: 'number' },
    verdict: { type: 'string' },
    verdictReason: { type: 'string' },
  },
}

const renderJson = (_a: unknown, v: unknown): { type: 'text'; text: string }[] => [
  { type: 'text', text: JSON.stringify(v) },
]

// 两个 execute 的入参走 `any`：其静态类型由 parameters 的 DSL 推出（数组字段一律推成
// JsonValue[]），与领域类型 ProbeSpec/CalibSpec 不可能同形。这是**显式边界**——
// 真正的校验在 probe.ts 里做（缺字段 / 形状不符一律 ok:false 带原因）。
type AnyArgs = Record<string, unknown>

export function apply(ctx: Context, config: Config): void {
  // enabled 必须在 apply() 里被消费：显式 false 时挂载但不贡献任何工具/副作用。
  // 只认 === false（未配置/undefined 视为启用），避免把「没写」误判成「关掉」（t-ef0af5ff）。
  if (config.enabled === false) return

  ctx.tools.register(
    defineTool({
      name: 'llmprobe_run',
      description:
        '对任意 OpenAI 兼容端点跑一批 prompt（prompts × reps），**只回读数**：调用数/失败数/延迟分位/字符数分布/正文 sha256/落盘路径——模型正文写进 JSONL 落盘、**不进上下文**。给 extract 正则时额外回抽取值的分布统计。端点不可达 / 响应形状不符 / 指定了凭据环境变量但它是空的 ⇒ ok:false 带原因（不是空结果）。',
      parameters: {
        url: { type: 'string', description: 'OpenAI 兼容的 chat/completions 端点，如 http://127.0.0.1:8095/v1/chat/completions。**无默认值**，必须显式给（防误打生产端点）', required: true },
        model: { type: 'string', description: '模型名，如 qwen3.8-27b', required: true },
        prompts: { type: 'array', description: '要跑的 prompt 列表（字符串数组）', required: true },
        system: { type: 'string', description: '可选的 system 消息（所有 prompt 共用）' },
        temperature: { type: 'number', description: '采样温度（缺省 0 = 确定性；测量实验一律用 0）' },
        maxTokens: { type: 'number', description: '输出上限（缺省 8 = 极短评分场景）' },
        reps: { type: 'number', description: '每个 prompt 重复次数（缺省 1）' },
        extract: { type: 'string', description: '可选：从回复正文抽数值的正则（取第一个捕获组；无匹配记 null 并计数）——评分器场景用它把「分数」取出来，正文不进上下文' },
        apiKeyEnv: { type: 'string', description: '可选：凭据所在的**环境变量名**（如 QWEN_API_KEY）。**不吃明文 key**——明文会落进会话日志' },
        outDir: { type: 'string', description: '可选：JSONL 落盘目录（缺省 $DSH_HOME/llm-probe）' },
        label: { type: 'string', description: '可选：本轮标签（写入 JSONL 与文件名，便于事后对账）' },
      },
      output: { schema: READINGS_SCHEMA, render: renderJson },
      async execute(args: AnyArgs) {
        return (await runProbe(args as unknown as ProbeSpec)) as never
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'llmprobe_calib',
      description:
        '**标定先行**：在测因变量之前，先验证「档位真的构成梯度」。对每档一个条件（如不同的 system）跑同一批探针，算各档指标均值与档间最大差 disp，再与调用者**显式给定**的无分辨力线比较，回三态裁决：has-resolution / no-resolution / apparatus-down。noiseFloor 必填且无默认——判据不可代填。',
      parameters: {
        url: { type: 'string', description: 'OpenAI 兼容端点（无默认值）', required: true },
        model: { type: 'string', description: '模型名', required: true },
        bands: { type: 'array', description: '档位数组，每项形如 {"id":"low","system":"…"}（id 必填；system 为该档条件；可另带 temperature）', required: true },
        probes: { type: 'array', description: '探针 prompt 列表（所有档共用同一批）', required: true },
        noiseFloor: { type: 'number', description: '无分辨力线：档间最大差 < 它 ⇒ 判无分辨力。**必填，无默认**——判据由调用者定，工具不代填', required: true },
        extract: { type: 'string', description: '从回复抽数值的正则（第一个捕获组）' },
        maxTokens: { type: 'number', description: '输出上限（缺省 8）' },
        reps: { type: 'number', description: '每格重复次数（缺省 1）' },
        apiKeyEnv: { type: 'string', description: '凭据的**环境变量名**（不吃明文）' },
        outDir: { type: 'string', description: 'JSONL 落盘目录（缺省 $DSH_HOME/llm-probe）' },
        label: { type: 'string', description: '可选：本轮标签' },
      },
      output: { schema: READINGS_SCHEMA, render: renderJson },
      async execute(args: AnyArgs) {
        return (await calibrate(args as unknown as CalibSpec)) as never
      },
    }),
  )
}
