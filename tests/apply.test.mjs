/**
 * 加载冒烟测试：**apply() 能不能真的被调用**。
 *
 * 为什么必须有这一条（2026-10-11 首次挂载实测）：单测 27/27 全绿、tsc 干净、守护预检 PASS，
 * 而插件在宿主里**根本没激活**（plugin_inspect 报 status=disabled，工具调不到报 unknown tool）。
 * 真因：output.schema 里三个嵌套 `{type:'object'}` 没写 explicit `additionalProperties`，
 * `defineTool` 在 apply() 内抛 `JsonSchemaError: ... additionalProperties must be explicitly true or false`。
 *
 * ⇒ 那一整套默认绿都是**假绿**：纯层单测只测 probe.ts，冒烟测试只读源码文本，
 *   而预检的组合试运行**跳过了 disabled 行**。**没有一条判据测过「这个插件的 apply 能跑」。**
 *   本文件补上这一环——它不需要宿主、不需要网络，纯本地一次调用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject } from '../lib/index.js'

function fakeCtx() {
  const registered = []
  return { registered, ctx: { tools: { register: (t) => registered.push(t) } } }
}

test('加载冒烟：apply() 可调用且注册两个工具（defineTool 的 schema 必须被编译器接受）', () => {
  const { registered, ctx } = fakeCtx()
  apply(ctx, { enabled: true })
  assert.equal(registered.length, 2, 'apply 应注册两个工具——少于 2 个说明 defineTool 在某处抛了或被跳过')
  const names = registered.map((t) => (t && t.name !== undefined ? t.name : '')).sort()
  assert.deepEqual(names, ['llmprobe_calib', 'llmprobe_run'])
})

test('enabled === false ⇒ 挂载但不贡献任何工具', () => {
  const { registered, ctx } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(registered.length, 0)
})

test('enabled === undefined 视为启用（只认 === false）', () => {
  const { registered, ctx } = fakeCtx()
  apply(ctx, {})
  assert.equal(registered.length, 2)
})

test('导出面：name / inject 形状正确', () => {
  assert.equal(name, 'agent-llm-probe')
  assert.deepEqual([...inject], ['tools'])
})
