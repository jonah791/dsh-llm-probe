/**
 * 骨架冒烟测试（由 dsh-plugin-forge 生成，2026-09-20）。
 * 只断言结构、不依赖构建产物——`npm test` 在生成后立刻可跑；
 * 业务逻辑测试请另加 tests/<主题>.test.mjs（跑 lib/ 产物，与运行时同源）。
 * 全 13 条 = 结构 5 + 两组契约守卫：
 *   生态（《DSH 插件生态倡议书》）：inject 覆盖源码 service · 不导入跨插件内部路径 · 能力边界已声明；
 *   Fabric（RFC 0001 v0.1 Draft）：manifest 必填字段 · $schema 必须自证 draft · id/capability 白名单 ·
 *     subscriptions/contributes 自洽 · entrypoint 不依赖 DSH/Cordis。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (p) => readFileSync(join(root, p), 'utf8')

/** cordis Context 上的内建成员（非 service）——与生成器同算法 */
const CORE_CTX = new Set(['logger','on','once','off','emit','parallel','waterfall','bail','serial','effect','set','get','has','inject','scope','isolate','extend','plugin','root','registry','reflect','start','stop','dispose','provide','accessor','mixin','config','name','active'])
/** Fabric v0.1 协商 capability 白名单（RFC 0001 §7.3 / §11） */
const FABRIC_CAPS_V01 = ['commands', 'messages.observe', 'storage.local']
/** 剔除注释后再判 import——注释里提到包名不算依赖（否则文档会把自己判违规） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
function ctxServices(text) {
  const out = new Set()
  const re = /\bctx\s*\.\s*([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(text)) !== null) if (!CORE_CTX.has(m[1])) out.add(m[1])
  return [...out].sort()
}
function declaredInject(text) {
  const m = /export const inject = (\[[^\]]*\]) as const/.exec(text)
  assert.ok(m, 'src/index.ts 必须导出 inject')
  // 不 JSON.parse：源码按本地风格用单引号，而 JSON 只认双引号 ⇒ 解析器会把自己的引号习惯
  // 判成「违规」（2026-10-11 实测一次假红）。按字符串字面量提取，两种引号都认。
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
}

test('package.json 可解析且暴露 build/test/prepare 脚本', () => {
  const pkg = JSON.parse(readText('package.json'))
  assert.equal(pkg.name, "dsh-llm-probe")
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(pkg.scripts.build, '必须有 build 脚本')
  assert.ok(pkg.scripts.test, '必须有 test 脚本（回归能力）')
  assert.ok(pkg.scripts.prepare, '必须有 prepare 脚本（否则从 git/npm 安装得到空壳：main 指向 lib 而 lib 被 gitignore）')
})

test('src/index.ts 暴露 name / inject / apply', () => {
  const text = readText(join('src', 'index.ts'))
  assert.ok(text.includes('export const name = '), '必须导出 name')
  assert.ok(text.includes('export const inject = '), '必须导出 inject')
  assert.ok(text.includes('export function apply('), '必须导出 apply')
})

test('tsconfig.json 是 ESM/NodeNext 配置', () => {
  const ts = JSON.parse(readText('tsconfig.json'))
  assert.equal(ts.compilerOptions.module, 'NodeNext')
  assert.equal(ts.compilerOptions.outDir, 'lib')
})

test('语义文档存在（新能力开工前先落文档）', () => {
  assert.ok(existsSync(join(root, 'docs', 'semantic.md')), '缺 docs/semantic.md')
})

test('cordis.patch.yml 含组合行 id', () => {
  const yml = readText('cordis.patch.yml')
  assert.ok(yml.includes("agent-llm-probe"))
})

test('声明清晰：inject 覆盖源码里用到的全部 service', () => {
  const text = readText(join('src', 'index.ts'))
  const declared = new Set(declaredInject(text))
  const missing = ctxServices(text).filter((s) => !declared.has(s))
  assert.deepEqual(missing, [], '源码用到了未声明的 service（cordis 严格代理下启动即抛错）：' + missing.join(', '))
})

test('组合优先：无跨插件/宿主内部路径导入', () => {
  const text = readText(join('src', 'index.ts'))
  const bad = []
  const re = /(?:from|require\s*\()\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (/^(?:@deepseek-ai\/[a-z0-9.-]+|dsh-[a-z0-9-]+)\/(?:lib|src|dist|build)\//.test(m[1])) bad.push(m[1])
  }
  assert.deepEqual(bad, [], '导入了别家包的内部路径——请改走公开入口：' + bad.join(', '))
})

test('Fabric manifest：存在且必填字段齐全（RFC 0001 §7.1）', () => {
  const m = JSON.parse(readText('dsh-plugin.json'))
  for (const k of ['$schema','manifestVersion','id','name','version','apiVersion','entrypoints','capabilities','subscriptions','contributes']) {
    assert.ok(k in m, 'manifest 缺字段 ' + k)
  }
  assert.equal(m.name, "dsh-llm-probe")
  assert.equal(m.entrypoints.host, 'lib/fabric.js')
  assert.equal(m.manifestVersion, '0.1.0')
})

test('Fabric manifest：$schema 必须是**显式 draft 占位**（不得冒充已发布标识符）', () => {
  const m = JSON.parse(readText('dsh-plugin.json'))
  assert.match(String(m.$schema), /draft/, 'RFC §7.1 要求 canonical $schema，但该标识符尚未发布（§14 开放问题 1）⇒ 只能是自证 draft 的占位')
})

test('Fabric manifest：id 反向 DNS + capability 只用 v0.1 白名单（§7.3/§11）+ 不得含 provides/requires（§7.1）', () => {
  const m = JSON.parse(readText('dsh-plugin.json'))
  const parts = String(m.id).split('.')
  assert.ok(parts.length >= 2 && parts.every((p) => /^[a-z][a-z0-9-]*$/.test(p)), 'id 形态非法：' + m.id)
  const keys = [...Object.keys(m.capabilities.required), ...Object.keys(m.capabilities.optional)]
  for (const k of keys) {
    assert.ok(FABRIC_CAPS_V01.includes(k) || /^x-[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(k), 'capability 不在 v0.1 白名单：' + k)
  }
  assert.ok(!('provides' in m) && !('requires' in m), 'RFC §7.1：v0.1 必须拒绝 provides / requires.services')
})

test('Fabric manifest：subscriptions 与 contributes.commands 形状正确（§7.1；两类声明不可混）', () => {
  const m = JSON.parse(readText('dsh-plugin.json'))
  for (const s of m.subscriptions) {
    assert.ok(s.event && s.version, 'subscription 缺 event/version：' + JSON.stringify(s))
  }
  for (const c of m.contributes.commands) {
    assert.ok(String(c.id).startsWith(m.id + '.'), 'command id 不在自身命名空间：' + c.id)
    assert.ok(c.title, 'command 缺 title：' + c.id)
  }
})

test('Fabric entrypoint：不依赖 DSH/Cordis（§7.1）且默认导出', () => {
  const src = stripComments(readText(join('src', 'fabric.ts')))
  assert.ok(!/@deepseek-ai\//.test(src), 'Fabric entrypoint 不得 import @deepseek-ai/*（已剔除注释）')
  assert.ok(!/from\s+['\"]cordis['\"]/.test(src), 'Fabric entrypoint 不得 import cordis（已剔除注释）')
  assert.ok(/export default/.test(src), 'Fabric entrypoint 必须默认导出')
})

test('能力边界与措辞禁令已声明（capability ≠ 沙箱；Draft ≠ 认证）', () => {
  const readme = readText('README.md')
  assert.match(readme, /不构成安全沙箱/, 'RFC 0001 §5：capability 声明不是沙箱')
  assert.match(readme, /不是认证/, 'RFC 0001 §13：插件不得自称「通过 Fabric 认证」或「安全」')
  assert.match(readme, /非标准|未定义/, 'RFC 0001 §7.1：其他扩展路径（Cordis 面）必须明确标为非标准')
  const gi = readText('.gitignore')
  assert.ok(gi.includes('node_modules/'), '.gitignore 必须忽略 node_modules')
})

test('Fabric manifest：$schema 版本段与 manifestVersion 一致（§7.1：不得成为第二协商轴）', () => {
  const m = JSON.parse(readText('dsh-plugin.json'))
  const mm = String(m.manifestVersion).split('.').slice(0, 2).join('.')
  assert.ok(String(m.$schema).includes('v' + mm), '$schema 版本段(' + mm + ') 必须与 manifestVersion 一致：' + m.$schema)
})
