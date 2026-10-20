/**
 * 本地 defineTool 实现：与 @deepseek-ai/dsh-tools 的 defineTool 行为一致，
 * 但内联在本插件内，避免运行时对宿主包的 import 依赖。
 *
 * 契约（与宿主一致，勿改）：
 *   parameters  → { type:'object', properties:{...}, required?:[...] }
 *   output.schema → 合法 JSON Schema 子集
 *   产出的定义形如 { name, description, parameters, output:{schema, render, presentationMeta?}, execute, ... }
 *
 * 作者侧 DSL 支持：type / description / enum / items / properties /
 * required(布尔或数组) / additionalProperties。
 */

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array', 'json']);

function compileNode(node, path, propertyMap) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path} 必须是 schema 对象`);
  }
  const type = node.type;
  if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
    throw new TypeError(`${path}.type 必须是 ${[...SUPPORTED_TYPES].join('/')} 之一`);
  }
  if (type === 'json') {
    // 作者侧的 "任意 JSON" 节点编译为纯注解 schema。
    const annotation = {};
    if (typeof node.description === 'string') annotation.description = node.description;
    return annotation;
  }

  const out = { type };

  if (typeof node.description === 'string') out.description = node.description;
  if (typeof node.title === 'string') out.title = node.title;
  if (Array.isArray(node.enum)) out.enum = [...node.enum];
  if (Object.prototype.hasOwnProperty.call(node, 'const')) out.const = node.const;

  if (type === 'object') {
    // 只有作者显式声明时才写 additionalProperties；不写即不限制，
    // 免得嵌套结构因为多出一个字段就被输出校验打回。
    if (node.additionalProperties !== undefined) {
      out.additionalProperties = node.additionalProperties === true;
    }
    const required = [];
    if (node.properties !== undefined) {
      if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
        throw new TypeError(`${path}.properties 必须是对象`);
      }
      out.properties = {};
      for (const [key, child] of Object.entries(node.properties)) {
        out.properties[key] = compileNode(child, `${path}.properties.${key}`, null);
        if (child !== null && typeof child === 'object' && !Array.isArray(child) && child.required === true) {
          required.push(key);
        }
      }
    }
    if (Array.isArray(node.required)) required.push(...node.required.map(String));
    if (required.length > 0) out.required = required;
    if (out.properties === undefined) delete out.properties;
  }

  if (type === 'array') {
    if (node.items === undefined) {
      throw new TypeError(`${path}.items 是 array 节点的必填项`);
    }
    out.items = compileNode(node.items, `${path}.items`, null);
  }

  if (propertyMap !== null) {
    // 参数表的每个条目本身就是属性节点，不应再嵌套 required 布尔值。
    delete out.required;
  }
  return out;
}

/** 参数表（隐式开放对象）→ 原始 JSON Schema。 */
function compileParameters(spec) {
  if (spec === undefined || spec === null) return { type: 'object', properties: {} };
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('parameters 必须是参数名到 schema 的映射');
  }
  const properties = {};
  const required = [];
  for (const [key, child] of Object.entries(spec)) {
    properties[key] = compileNode(child, `parameters.${key}`, null);
    if (child !== null && typeof child === 'object' && !Array.isArray(child) && child.required === true) {
      required.push(key);
    }
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 轻量参数校验：失败时抛出与宿主同形的错误。 */
function validateArgs(schema, args) {
  const violations = [];
  if (typeOf(args) !== 'object') {
    return [`arguments 必须是对象，收到 ${typeOf(args)}`];
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined) {
      violations.push(`"${key}" 是必填参数`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const spec = properties[key];
    if (spec === undefined) continue; // 隐式开放对象：未知参数放行
    const want = spec.type;
    if (want === undefined) continue;
    const got = typeOf(value);
    const ok = want === got
      || (want === 'number' && got === 'number' && Number.isFinite(value))
      || (want === 'integer' && got === 'number' && Number.isInteger(value));
    if (!ok) violations.push(`"${key}" 必须是 ${want}，收到 ${got}`);
    else if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      violations.push(`"${key}" 必须是 ${spec.enum.map((v) => JSON.stringify(v)).join(' / ')} 之一`);
    }
  }
  return violations;
}

/**
 * 定义一个工具。与宿主 defineTool 同形，便于将来切换回官方实现。
 * @param {object} options 工具定义
 * @returns {object} 可交给 ctx.tools.register 的定义
 */
export function defineTool(options) {
  const userExecute = options.execute;
  const userRender = options.output.render;
  const userPresentationMeta = options.output.presentationMeta;
  const userPresentCall = options.presentCall;
  const userPresentResult = options.presentResult;
  const userIsConcurrencySafe = options.isConcurrencySafe;

  if (options.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs 必须是正有限数`);
  }

  const parameters = compileParameters(options.parameters);
  const outputSchema = compileNode(options.output.schema, 'output.schema', null);
  const validate = (args) => validateArgs(parameters, args);

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value);
      },
      ...(userPresentationMeta !== undefined
        ? {
          presentationMeta(args, value) {
            return userPresentationMeta(args, value);
          },
        }
        : {}),
    },
    ...(options.deferLoading === true ? { deferLoading: options.deferLoading } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) {
        const error = new Error(`invalid arguments: ${violations.join('; ')}`);
        error.name = 'ToolArgsError';
        error.code = 'INVALID_ARGS';
        error.violations = violations;
        throw error;
      }
      // Optional fields may be undefined internally; the host requires lossless JSON.
      const value = await userExecute(args, exec);
      return JSON.parse(JSON.stringify(value));
    },
  };

  if (typeof userPresentCall === 'function') {
    tool.presentCall = (args) => (validate(args).length > 0 ? undefined : userPresentCall(args));
  }
  if (typeof userPresentResult === 'function') {
    tool.presentResult = (args, result) => (
      validate(args).length > 0 ? undefined : userPresentResult(args, result)
    );
  }
  if (typeof userIsConcurrencySafe === 'function') {
    tool.isConcurrencySafe = (args) => (
      validate(args).length > 0 ? false : userIsConcurrencySafe(args)
    );
  }

  return tool;
}

/** 供测试使用：暴露编译结果。 */
export const __internals = { compileNode, compileParameters, validateArgs };
