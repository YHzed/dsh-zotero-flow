/**
 * 只读自检：加载插件入口、构造运行时、调用不写库的工具。
 *
 *   node scripts/test-tools.mjs
 */

import { apply, inject, name as pluginName } from '../index.js';
import { buildTools, createRuntime } from '../lib/tools.js';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

// 1) 插件入口形状
check('插件 name', pluginName === 'dsh-zotero-flow', pluginName);
check('插件 inject', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject));
check('导出 apply', typeof apply === 'function', '');

// 2) 工具注册（用假的 ctx 观察注册动作）
const registered = [];
const effects = [];
const fakeCtx = {
  tools: { register: (definition) => { registered.push(definition); return () => {}; } },
  effect: (fn) => { effects.push(fn); const disposer = fn(); return disposer; },
  inject: (deps, callback) => { effects.push(() => callback(fakeCtx)); },
};
try {
  apply(fakeCtx, {});
  check('apply 不抛异常', true, `注册了 ${registered.length} 个工具，挂了 ${effects.length} 个 effect`);
} catch (error) {
  check('apply 不抛异常', false, error.stack ?? error.message);
}

const EXPECTED_TOOLS = [
  'zotero_status',
  'library_sites',
  'literature_lookup',
  'scholar_session',
  'scholar_download',
  'zotero_collections',
  'zotero_save',
  'zotero_import_pdf',
  'zotero_search',
  'zotero_attach_pdf',
];
const names = registered.map((tool) => tool.name);
check('工具齐全', EXPECTED_TOOLS.every((tool) => names.includes(tool)), names.join(', '));

// 3) 每个工具的 schema 可被自身校验器接受，且 render 能出文本
for (const tool of registered) {
  const okShape = tool.parameters?.type === 'object'
    && typeof tool.execute === 'function'
    && tool.output?.schema !== undefined
    && typeof tool.output.render === 'function';
  check(`工具 ${tool.name} 定义完整`, okShape, `参数 ${Object.keys(tool.parameters?.properties ?? {}).length} 个`);
}

// 4) 实跑只读工具
const runtime = createRuntime({});
const tools = new Map(buildTools(runtime).map((tool) => [tool.name, tool]));

async function run(toolName, args = {}) {
  const tool = tools.get(toolName);
  const value = await tool.execute(args, { signal: undefined });
  return { tool, value, content: tool.output.render(args, value) };
}

console.log('\n--- zotero_status ---');
try {
  const { tool, value, content } = await run('zotero_status');
  console.log(content[0].text);
  check('zotero_status 渲染出文本', typeof content[0]?.text === 'string' && content[0].text.length > 0, '');
  check('zotero_status 读到 Zotero', value.zotero?.running === true, `version=${value.zotero?.version}`);
  if (tool.output.presentationMeta) {
    const meta = tool.output.presentationMeta({}, value);
    check('presentationMeta 可 JSON 序列化', JSON.stringify(meta).length > 2, `${JSON.stringify(meta).length} 字节`);
  }
} catch (error) {
  check('zotero_status 执行', false, error.stack ?? error.message);
}

console.log('\n--- library_sites ---');
try {
  const { value, content } = await run('library_sites', {});
  console.log(content[0].text.split('\n').slice(0, 6).join('\n'), '\n  …');
  check('library_sites 条数', value.count >= 15, `${value.count} 项`);
} catch (error) {
  check('library_sites 执行', false, error.stack ?? error.message);
}

console.log('\n--- zotero_collections(targets) ---');
try {
  const { value, content } = await run('zotero_collections', { action: 'targets' });
  console.log(content[0].text);
  check('zotero_collections 拿到目标', Array.isArray(value.collections), `${value.collections.length} 个目标`);
} catch (error) {
  check('zotero_collections 执行', false, error.stack ?? error.message);
}

console.log('\n--- literature_lookup(DOI) ---');
try {
  const { value, content } = await run('literature_lookup', { query: '10.1038/nature12373' });
  console.log(content[0].text);
  check('literature_lookup 命中', value.count >= 1, `kind=${value.kind} count=${value.count}`);
} catch (error) {
  check('literature_lookup 执行（可能受网络影响）', false, error.stack ?? error.message);
}

console.log(`\n[test-tools] ${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
