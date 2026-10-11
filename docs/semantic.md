# dsh-llm-probe · 语义文档

> 元信息：版本 v0.1 · 状态 draft · 最近复核 2026-10-11 · owner agent-llm-probe

## 1 · 定位与反定位

**是什么**：把**任意 OpenAI 兼容端点**当**测量装置**跑实验的工具面。三个不可让渡的性质：**直连**（不走 harness 模型路由）、**只回读数**（模型正文落盘成 JSONL，不进上下文）、**标定先于测量**（`llmprobe_calib` 先验证「档位真的构成梯度」，再允许测因变量）。

**不是什么**：
- **不是聊天客户端**——不维护会话、不装配预设、不做角色卡/世界书（那是 `dsh-model-test` 的事）。
- **不是模型/provider 管理器**——不注册 provider、不改路由配置、不管凭据存储；端点与凭据都由调用者每次显式给。
- **不是评分器**——它不判断「分高不高」。`extract` 只做一件事：按调用者给的正则把数值抠出来并统计；**指标的语义归调用者**。
- **不是实验设计器**——判据、阈值（`noiseFloor`）、样本量都不代填（判断不可代填）。

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| **档位（band）** | 自变量的一个取值。本工具里 = 一套条件（`system` / `temperature`）。「三档」就是三套条件 |
| **探针（probe）** | 用于测装置性质的输入 prompt。标定时所有档共用同一批探针 |
| **disp** | 档间**均值**的最大差（`max(mean) - min(mean)`），即「这套操纵到底造出了多大梯度」的读数 |
| **noiseFloor** | 无分辨力线：`disp < noiseFloor` ⇒ 判「测不出梯度」。**由调用者显式给，无默认值** |
| **读数（readings）** | 本工具的返回体：调用数/失败数/延迟分位/字符分布/正文 sha256/落盘路径等。**不含正文全文** |
| **正文（text）** | 模型的原始输出。只进 JSONL（`outPath`），不进返回值、不进上下文 |
| **apparatus-down** | 装置没起来（零调用 / 全部失败 / 有数据的档不足 2 个）—— **与「测不出」严格区分** |

## 3 · 概念模型与不变量

```
调用者（agent） ──工具入参──▶ [参数守卫] ──▶ [逐格调用（fetch）] ──▶ [JSONL 落盘]
                                   │                    │
                                   │                    └──▶ [聚合：stats / disp / verdict]
                                   └── 守卫失败 ⇒ ok:false + reason（不发起任何网络请求）
```

不变量（必须永远为真）：

1. **正文不进上下文**：返回体只含 ≤120 字符的截断预览（`samples`，最多 3 条），完整正文只在 `outPath` 指向的 JSONL 里。
2. **全部失败 ⇒ `ok:false`**：不允许出现「ok:true 且 0 次成功」——那等于把「端点不可达」伪装成「模型答了空」。（JSONL 在判定前已落盘，证据不丢。）
3. **判据不代填**：`noiseFloor` 必填且无默认；缺它就是 `ok:false`，不是「用某个默认值跑跑看」。
4. **凭据不吃明文**：入参只有 `apiKeyEnv`（环境变量名）；指定了但变量为空 ⇒ 拒绝调用（不静默裸调换来一个把人带偏的 401）。
5. **三态严格区分**：`apparatus-down`（仪器坏了）/ `no-resolution`（有数据但测不出梯度）/ `has-resolution`（只证到自变量有梯度，因变量尚未测）。
6. **观测不反噬**：单格失败记为该格的失败与原因，不中断整批（除了「全批失败」这一种，它转成不变量 2）。

## 4 · 契约

### 4.1 配置（Config schema）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `enabled` | boolean | `true` | 只认 `=== false` 关闭（未配置视为启用）；关闭时挂载但不贡献工具 |

其余可调参数**一律走工具入参**，不落配置：`outDir` 缺省 `$DSH_HOME/llm-probe`，超时固定 60 s。

### 4.2 工具面

**`llmprobe_run`** —— 跑一批 `prompts × reps`，只回读数。
入参：`url`（必填，无默认端点）· `model`（必填）· `prompts`（必填，字符串数组）· `system?` · `temperature?`（缺省 0）· `maxTokens?`（缺省 8）· `reps?`（缺省 1）· `extract?`（正则，取第一个捕获组）· `apiKeyEnv?` · `outDir?` · `label?`。
出参：`ok` / `reason?` / `endpoint` / `model` / `calls` / `failures` / `failReasons` / `outPath` / `contentSha` / `samples` / `uniqueOutputs` / `wallMs` / `latencyMs?` / `chars?` / `extracted?`。

**`llmprobe_calib`** —— 标定：每档一套条件，跑同一批探针 ⇒ 三态裁决。
入参：`url` · `model` · `bands`（必填，≥2 档，每项 `{id, system?, temperature?}`）· `probes`（必填）· `noiseFloor`（必填）· `extract?` · `maxTokens?` · `reps?` · `apiKeyEnv?` · `outDir?` · `label?`。
出参：`llmprobe_run` 的全部 + `noiseFloor` / `perBand` / `disp?`（装置没起来时**省略该字段**，不回 null）/ `verdict` / `verdictReason`。

### 4.3 调用点清单 [MUST]

| 调用点 | 位置 | 说明 |
|--------|------|------|
| 工具注册 | `src/index.ts` 的 `apply()` → `ctx.tools.register` | 两个 `defineTool`；`inject = ['tools']` |
| 决策逻辑 | `src/probe.ts` 的 `runProbe` / `calibrate` | 被 `src/index.ts` 静态导入调用 |
| 纯层（离线可测） | `src/probe.ts` 的 `stats` / `buildChatBody` / `parseChatResponse` / `extractNumber` / `calibrateVerdict` / `contentFingerprint` / `resolveOutDir` | 零 I/O；`tests/probe.test.mjs` 直接调用 |
| **出网** | `src/probe.ts` 的 `callOnce` → `fetch(url, ...)` | 本插件**唯一**的网络出口；URL 完全由调用者给 |
| 落盘 | `src/probe.ts` 的 `persist` → `writeFile` | 唯一写盘点；目录来自 `resolveOutDir` |
| 读环境变量 | `src/probe.ts` 的 `resolveKey` → `process.env[apiKeyEnv]` | 凭据唯一入口；不回显、不落盘 |

## 5 · 边界与信任

- **能力边界**：本插件与宿主**同进程、全权限**。`capabilities` 声明用于兼容判断，**不是沙箱**。
- **输入信任级别**：`url` / `prompts` / `bands` 全部来自调用者（我）。URL **无默认值**是有意的——默认端点会让「误打生产端点」变成默认行为。
- **网络副作用**：调用会**花对方的钱**（外部 provider）或占用本机算力。故本插件不设默认端点、不设默认 key、也不做任何后台轮询/定时器（**零自主出网**：没有调用就没有网络）。
- **凭据与隐私**：只吃**环境变量名**。模型正文落进 `$DSH_HOME/llm-probe/*.jsonl`（本机、不进仓库）；若正文含敏感内容，由调用者决定跑什么、写哪里。
- **不做的事**：不绕过任何站点/服务的访问控制——它就是一个 HTTP 客户端。

## 6 · 与既有机制的关系

| 机制 | 分工 | 为什么不合并 |
|------|------|--------------|
| `dsh-model-test` | 预设迭代：角色卡/世界书/预设装配 + `modeltest_play` 走 **harness 模型路由** | 它的契约是预设域（card/session/preset），且**指不了**本地 OpenAI 兼容端点（R-Q2 的实测结论）。加进来会把工具面拆成两半 |
| `dsh-agent-vision` | 多模态问答（`vision_ask`），同样打 DashScope | 那条路是「**问一个问题要一个答案**」；本插件是「**同一批输入跑 N 次、要的是分布**」 |
| 宿主 `ctx.llm` seam | 供 agent-loop / compaction 用的 provider 中立流式服务 | 本插件**有意不用**：测量要的是**裸补全**（无 agent 循环、无工具、无额外 system），且实验必须能指向任意端点而不改宿主组合 |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令/单测名/日志行） | 状态 |
|---|-----------|--------------------------|------|
| A1 | 单测全绿（含尸体样本与**加载冒烟**），且尸体确实会被拦 | `node --test "tests/*.test.mjs"` → exit 0 · `# tests 31` / `# pass 31` / `# fail 0` | 已验证 |
| A2 | 端点不可达 ⇒ `ok:false` 且**JSONL 仍落盘** | 单测 `尸体 · runProbe 对死端点`：`reason` 匹配「全部 2 次调用失败」、读回 `outPath` 得 3 行（header + 2 记录） | 已验证 |
| A3 | 标定三态都可达（不是恒绿机） | 单测 `calibrateVerdict：三态五分支` 走 apparatus-down 三例 / no-resolution 一例 / has-resolution 二例 | 已验证 |
| A4 | 凭据不吃明文 | 源码级：`parameters` 无 key/secret/token 字段，只有 `apiKeyEnv`；单测 `尸体 · 指定了凭据环境变量但它是空的` 断言拒绝调用 | 已验证 |
| A5 | `apply()` 能跑通且注册两个工具（**加载冒烟**——它才是抓「插件根本没活」的那条） | `tests/apply.test.mjs` 4 条：apply 注册 2 个工具 / `enabled:false` 注册 0 个 / `enabled` 缺省视为启用 / 导出面形状 | 已验证 |
| A6 | 宿主里真的激活：`llmprobe_run` 可调且对本机 NInfer 实调成功 | 2026-10-11 15:11:07 实调 → `ok:true` · `calls:2` · `failures:0` · `samples:["7","17"]`（3+4=7 / 8+9=17，答对）· `extracted.values:[7,17]` · `contentSha:"53acefe10e5deb32"` · `outPath` 指向 `$DSH_HOME/llm-probe/…jsonl` | **已验证** |
| A7 | 正文不进上下文：返回体不含正文全文 | 同一次实调：返回体只有 `samples`（3 条 × ≤120 字符）+ `chars{min,max,mean}` + sha256；完整正文只在 `outPath` 的 JSONL 里 | **已验证** |
| A8 | 标定线上可用且**能返回「无分辨力」** | 2026-10-11 15:11:19 实调（2 档 × 3 探针 × rep 2 = 12 次 · 3.4 s）→ `perBand` 两档 `mean` 全等 12.3333 · `disp:0` · **`verdict:"no-resolution"`** · reason：「档间最大差 0 < 无分辨力线 0.5 ⇒ 测不出档位梯度，**不得继续测因变量**」 | **已验证** |

> `verified` 要求 `pending == 0`。**A1–A8 全部达成**（2026-10-11 15:11）。

### 结论：挂载当天不激活的真因（2026-10-11 15:07 定案 · 实测证据）

**宿主兼容门静默 disable 了它**，原文（来自真实启动的 stderr）：

```
dsh: disabling profile plugin row "agent-llm-probe": Plugin dsh-llm-probe@0.1.0 is
incompatible with dsh 0.2.1-alpha.2: peerDependencies {"@deepseek-ai/dsh-tools":"^0.1.0-rc.6"}.
Running it may cause crashes or data loss. … Exact-version exemption: not active.
```

**根因在 `dsh-plugin-forge@0.3.1` 的模板**：它给 `@deepseek-ai/dsh-tools` 写的是 **`^0.1.0-rc.6`**（caret 排除 0.2.x），而全部可用自研插件用的都是 **`>=0.1.0-rc.6`**。⇒ 运行时是 `0.2.1-alpha.2` 时，**每一个新 forge 出来的插件都出生即不兼容、出生即被静默 disable**。

改成 `>=0.1.0-rc.6`（与 `dsh-semantic-docs` / `dsh-knowledge-graph` / `dsh-pdf-render` 一致）后，真试运行不再出现 `disabling` 行，重启即激活。

**为什么前面绕了这么久（两个仪器缺口，都值得单独修）**：
1. **守护预检的 `trialRun` 被短路**——`preflight/src/index.ts` 的判据是「目标端口上现有实例健康 ⇒ 不 spawn 重复实例」。⇒ 它报 `full PASS` 与插件被 disable **可以同时为真**。
2. **`.dsh/logs/` 里没有本次启动的 stderr**——错误文本必须靠**手动跑一次真试运行**才能拿到。拿到它的正确配方（照 `preflight/src/core.ts:525` 抄）：
   ```
   DSH_PREFLIGHT_TRIAL=1 node --expose-internals <dsh>/lib/bin.js --profile web --port <空闲> --no-open
   ```
   ⚠ **必须在 Windows 侧跑**（WSL 侧会因 `node-addon-require-builtin-linux-x64-gnu` 缺原生绑定而假失败——那是平台问题，不是插件问题）。

**中途排除掉的（都实测过，都不是原因，避免后人重复）**：模块解析落点（两视角解析到同一 file URL）· `package.json` 顶层键 · 同级 `cordis.patch.yml` 形态 · 组合基线残留行（整行删掉也会被重建）。

**顺带修掉的两个真缺陷**：① npm 在插件目录自动装进 **16 个 `@deepseek-ai` 同伴副本**（同包双实例风险，`dsh-model-test` 历史上犯过两次）⇒ 已 BAk 成 `@deepseek-ai.BAK-20261011-1448`；② `output.schema` 的**三个嵌套 object 未显式写 `additionalProperties`** ⇒ `defineTool` 在 `apply()` 内抛 `JsonSchemaError`（这是**第一次挂载确实失败**的原因，与最终的兼容门是两回事）。

## 8 · 与实现的关系

- 主实现：`src/index.ts`（薄壳 · 工具面）；决策逻辑：`src/probe.ts`（纯层 + 薄 I/O 层）。
- 测试：`tests/probe.test.mjs`（纯层金标准 + 五处尸体样本）· `tests/apply.test.mjs`（**加载冒烟**，见 A5）· `tests/smoke.test.mjs`（生成器自带的生态闸门）。
- 同语义副本：无（本文件是唯一真源）。

## 9 · 实践修订记录

- **2026-10-11 首次生成**：由 `dsh-plugin-forge` 生成骨架——本节的每一次语义修正都追加在下方，不回改历史。
- **2026-10-11 建仓当天修了生成器骨架的一处假红**：`tests/smoke.test.mjs` 的 `declaredInject` 原用 `JSON.parse` 解源码里的 `inject` 数组，而本地代码风格是**单引号** ⇒ JSON 只认双引号 ⇒ 自己的引号习惯被判成违规。改为按字符串字面量提取（两种引号都认）后全绿。**已登记为插件生成器的改进项**（`dsh-plugin-forge` 的模板应同步）。
- **2026-10-11 工具入参类型走显式边界**：`execute` 的入参静态类型由 `parameters` DSL 推出（数组字段一律推成 `JsonValue[]`），与领域类型不可能同形 ⇒ 在 `index.ts` 显式声明为宽类型，**真校验放在 `probe.ts`**（缺字段/形状不符一律 `ok:false`）。这比在类型层假装它们同形更诚实。
- **2026-10-11 ★ 一次「整套默认绿」的假绿，与补上的那条判据**：首次挂载时，`tsc` 干净、单测 27/27 全绿、守护预检 full PASS、`plugin_mount` 报「已挂载」——**而插件在宿主里根本没激活**。根因是 `output.schema` 里三个嵌套 `{type:'object'}` 没写 explicit `additionalProperties`，`defineTool` 在 `apply()` 内抛 `JsonSchemaError`。**为什么没被任何现有判据拦住**：纯层单测只测 `probe.ts`（不碰 `defineTool`）；源码级冒烟只读文本；预检的组合试运行**跳过了 disabled 行**（所以它 PASS 与插件死掉可以同时为真）。⇒ 新增 `tests/apply.test.mjs`：给一个假 ctx，直接调 `apply()`，断言注册了两个工具。**它不需要宿主、不需要网络，一次调用就能把「插件根本没活」这类失败从「上线才发现」拉回「本地就能测」。**
- **2026-10-11 依赖准备的反面教材（我自己踩的）**：在插件目录跑 `npm install typescript @types/node` 时，npm（v7+）**因为 `peerDependencies` 会自动把同伴装成副本**——实测落进 **16 个 `@deepseek-ai/*`**（含 `cordis`/`dsh-tools`/`schemastery`），构成**同包双实例**风险。已 BAk 掉。⇒ 纪律：**插件目录里装构建依赖必须避开同伴自动安装**（`--legacy-peer-deps` 或 `--omit=peer`），否则解析会拐进插件自己的副本而不是宿主的 link farm。

## 10 · 未决问题

- **U1 并发**：当前逐格**串行**调用。串行换来的是确定的顺序与简单的失败归因，代价是慢（126 次调用 × 每次数百毫秒）。是否要并发，取决于「端点能不能扛住并发」这个外部事实——**先量一次再决定**，不预先优化。
- **U2 超时不可调**：60 s 固定。长输出场景（本工具定位是评分式的极短输出）够用，但若将来要跑长文本生成就得开成入参。
- **U3 落盘无清理**：`$DSH_HOME/llm-probe/*.jsonl` 只增不减。跑多了会积——需要一个保留策略（或接进 `dsh-agent-checkpoint` 的清理范畴）。
- **U4 `additionalProperties: true` 的代价**：读数 schema 有意放宽（加字段不打死工具），代价是**未声明的错别字段不会被拦**。若将来读数形状稳定下来，应收紧成显式全声明。
- **U5 ★ 宿主为什么判它不激活（当前最大阻塞）**：见 §7 的「当前状态」。已知：不是残留行、不是模块解析、不是 manifest 形状、不是同级 patch 形态。**下一步入口 = 拿到 web 进程本次启动的 stderr**；旁证 = 预检 trialRun 对这个插件的激活**没有分辨力**（它 PASS 而插件是死的），这本身是一条值得单独修的判据缺口。

