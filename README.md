<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 把任意 OpenAI 兼容端点当测量装置跑实验：直连通话 · 只回读数（正文落盘不进上下文）· 标定先于测量 · 端点不可达即响亮失败
  inject: 'tools'
  tools: llmprobe_run,llmprobe_calib
  runtime: host-only
  envDeps: 一个 OpenAI 兼容端点（**必须显式给 URL**，无默认值——防误打生产端点）
  boundary: 只回读数不回正文（正文落盘 JSONL，不进上下文）；不替你选端点、不替你定判据（noiseFloor 必填无默认）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-llm-probe

<p align="center">
  <a href="https://github.com/jonah791/dsh-llm-probe"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-31%20passed-brightgreen" alt="tests">
</p>

**一句话**：把任意 OpenAI 兼容端点当**测量装置**跑实验——只回读数，正文落盘不进上下文。

**为什么值得用**：手写脚本跑实验的根因是**正文会灌爆上下文**（一次 30 条 prompt 的回复就能吃掉几万 token）。本插件只把**读数**带回上下文（调用数/失败数/延迟分位/字符数分布/正文 sha256/落盘路径），正文写进 JSONL 留给事后分析。配 `llmprobe_calib` 的「**标定先行**」——在测因变量之前先验证「档位真的构成梯度」（这一条是三轮实验作废换来的纪律）。

## 工具
- `llmprobe_run`：对任意 OpenAI 兼容端点跑一批 prompt（prompts × reps），**只回读数**：调用数/失败数/延迟分位/字符数分布/正文 sha256/落盘路径——模型正文写进 JSONL 落盘、**不进上下文**（今晚手写 8 个脚本的根因就是正文会灌爆上下文）。给 extract 正则时额外回抽取值的分布统计。端点不可达 ⇒ ok:false + 原因（不是空结果）。
- `llmprobe_calib`：**标定先行**（今晚三轮实验作废换来的第一纪律）：在测因变量之前，先验证「档位真的构成梯度」。对每档一个条件（如不同的 system），跑同一批探针，算各档指标均值与档间最大差 disp，再与调用者**显式给定**的无分辨力线比较，回三态裁决：has-resolution / no-resolution / apparatus-down。noiseFloor 必填且无默认——判据不可代填。

## 生态契约

> 依据《DSH 插件生态倡议书》三条原则：**组合优先 / 声明清晰 / 兼容优先**。

- **依赖 service**（`inject`）：`tools` —— 组合行装载时等待这些 service
- **贡献面**：工具 `llmprobe_run` · `llmprobe_calib`；slot 无；service 无
- 组合行 id：`agent-llm-probe`
- **Fabric manifest**：`dsh-plugin.json`（RFC 0001 v0.1 **Draft** 形状）——`id` = `com.jonah791.llm-probe`，required = （无），optional = （无）
- **Fabric 入口**：`src/fabric.ts` → `lib/fabric.js`（骨架，**不依赖 DSH/Cordis**；Fabric SDK 发布后填充实现）

> ⚠ **不是认证**：Fabric 目前只有文档草案（无正式 schema、无 SDK、无 conformance 套件），因此**不得**声称本插件
> 「通过 Fabric 认证」或「已符合 Fabric 标准」。对齐的是 RFC 0001 的 manifest 形状 + 可机械校验的明文规则；
> `dsh-plugin.json` 的 `$schema` 是**自证 draft 的占位**，Phase 0 发布 canonical identifier 后替换。

组合片段（`cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-llm-probe
      name: dsh-llm-probe
      config: {}
```

## 能力边界（诚实声明）

本插件与宿主**同进程、全权限**运行。「能力声明」用于兼容判断、用户确认与审计，**不构成安全沙箱**——不要把它当权限边界。
本插件不导入其他插件或宿主的内部路径（组合优先），也不覆盖别人的内部实现。

### 两个面，别混淆

- **Fabric 契约面**：`dsh-plugin.json` + `src/fabric.ts`（host entrypoint）。这是**前瞻声明**——Fabric 目前只有 RFC Draft，
  没有正式 schema / SDK / conformance 套件，官方 `docs/plugin-development.md` 明示其**尚不能作为依赖或发布目标**；
  `$schema` 是自证 draft 的 `.invalid` 占位（RFC §14-1 未定 canonical identifier），**不是** schema 校验通过，也**不是**认证。
- **DSH/Cordis 面（非标准扩展路径）**：`src/index.ts` + `cordis.patch.yml`——本插件**现在真正可运行**的形态。
  `tools` 不在 Fabric v0.1 的 capability 表内（v0.1 只有 host.info / log / 生命周期取消 + `storage.local` / `commands` / `messages.observe`），
  故这属标准之外的扩展路径：**不得**当作可移植 API，也**不得**成为 Fabric entrypoint 的依赖。

## 构建与挂载

```sh
pnpm build
# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）
```

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-llm-probe": "link:E:/alice/self-plugins/dsh-llm-probe"
```

**2) 挂组合**：

```yaml
- id: agent-llm-probe
  name: dsh-llm-probe
  config: {}
```

**3) 30 秒验证**：`llmprobe_run {url: "http://127.0.0.1:8095/v1/chat/completions", model: "qwen3.8-27b", prompts: ["1+1="], maxTokens: 8}` → 应返回**读数**（调用数/延迟/字符数/sha256/落盘路径）而**不是模型正文**；给一个不存在的 URL 再试 → 应 `ok:false` + 原因（**不是空结果**）。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `outDir` | `$DSH_HOME/llm-probe` | JSONL 落盘目录（正文写这里，不进上下文） |

⚠ **端点 URL 无默认值**——必须每次显式给（防误打生产端点）。

## 落盘与自证

| 文件 | 何时写 | 内容 |
|---|---|---|
| `<outDir>/<label>-<ts>.jsonl` | 每次 `llmprobe_run` | 每行一条：prompt / 回复正文 / 延迟 / 字符数 / sha256；**正文不进上下文** |

**一条命令答五问**：

```bash
tail -1 "$DSH_HOME/llm-probe/"*.jsonl
# ① 跑的是哪个构建 → 见 package.json version 与 lib mtime
# ② 谁发起        → 该行的 label
# ③ 断在哪一段    → 行数 < 请求数 = 有调用失败（读数里 failureCount 会报）
# ④ 结果质量      → 正文 sha256 与字符数分布
# ⑤ 耗时与预算    → 延迟分位
```

## 生效判据与回退

**判据**：行为级——`llmprobe_run` 返回读数而非正文；`llmprobe_calib` 对无梯度的档位返回 `no-resolution`（**三态互不掩盖**）。
**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`；③ 无状态，停用即完全静默。

## 测试

```bash
cd self-plugins/dsh-llm-probe && npm test
```

**31 条用例**（跑一次得到）：覆盖读数统计（调用数/失败数/延迟分位/字符分布/sha256）· extract 正则抽取与无匹配计数 · **端点不可达 ⇒ `ok:false` + 原因**（不是空结果）· 标定三态裁决（has-resolution / no-resolution / apparatus-down）· `noiseFloor` 缺失时拒绝。无需网络（走注入的假 fetch）。

## 设计要点

- **只回读数**：正文落盘、不进上下文——这是本插件存在的**全部理由**（手写脚本的根因就是正文灌爆上下文）。
- **标定先行**：先证「档位构成梯度」再测因变量——三轮实验作废换来的第一纪律；`noiseFloor` **必填无默认**（判据不可代填）。
- **三态互不掩盖**：`has-resolution` / `no-resolution` / `apparatus-down` —— 「测不出」与「装置坏了」是两件事。
- **端点不可达即响亮失败**：`ok:false` + 原因，绝不返回空结果（空结果会被读成「测了但没有效果」）。

## 相关文档

- [`docs/semantic.md`](docs/semantic.md) —— **权威契约**（定位/反定位 · 验收表）
- 中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)（本插件归 **认知层**）
- 相关技能：`llm-measurement-instrument`（把 LLM 当测量装置时的偏差操纵与判据校准）

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。
