// 样本数据校验：按 IR 校验样例，错误定位到嵌套字段路径。
// 同时提供"旧数据对照新结构"校验，用于改名别名的可读性验证。
// 未解析（unevaluated）的定义不产出任何通过结论，由上层拦截。

import { joinPath } from './util.js';

export class SampleValidationError extends Error {}

function isMissing(value) {
  return value === undefined;
}

/**
 * 按 IR 校验一条样例数据。
 * @returns {{ valid: boolean, errors: Array<{path:string, message:string, value:any}> }}
 */
export function validateSample(ir, data) {
  const errors = [];
  validateNode(ir.root, data, [], errors, { allowAlias: false });
  return { valid: errors.length === 0, errors };
}

/**
 * 用旧版本样例数据校验新 IR（模拟"旧生产者写新结构"）。
 * 新 record 字段上的 aliases 会被接受为旧字段名，验证改名后旧数据是否仍可读。
 */
export function validateOldSampleAgainstNew(newIr, oldData) {
  const errors = [];
  validateNode(newIr.root, oldData, [], errors, { allowAlias: true });
  return { valid: errors.length === 0, errors, aliasReadable: errors.length === 0 };
}

function validateNode(node, value, path, errors, opts) {
  // 可空
  if (value === null) {
    if (node.nullable) return;
    errors.push(err(path, `字段为 null，但类型未声明可空`, value));
    return;
  }

  switch (node.kind) {
    case 'primitive':
      checkPrimitive(node, value, path, errors);
      break;
    case 'enum':
      if (typeof value !== 'string') {
        errors.push(err(path, `枚举值必须是字符串，实际为 ${typeName(value)}`, value));
      } else if (!node.symbols.includes(value)) {
        errors.push(err(path, `枚举值 "${value}" 不在允许集合 [${node.symbols.join(', ')}] 中`, value));
      }
      break;
    case 'record':
      checkRecord(node, value, path, errors, opts);
      break;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(err(path, `期望数组，实际为 ${typeName(value)}`, value));
        break;
      }
      value.forEach((item, i) => validateNode(node.items, item, [...path, `[${i}]`], errors, opts));
      break;
    case 'map':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(err(path, `期望对象(map)，实际为 ${typeName(value)}`, value));
        break;
      }
      for (const [k, v] of Object.entries(value)) {
        validateNode(node.values, v, [...path, `{${k}}`], errors, opts);
      }
      break;
    case 'union':
      // 数据匹配任一成员即可；全部不匹配时报最后一个成员的错误
      let anyMatched = false;
      let lastErrors = [];
      for (const member of node.types) {
        const sub = [];
        validateNode(member, value, path, sub, opts);
        if (sub.length === 0) {
          anyMatched = true;
          break;
        }
        lastErrors = sub;
      }
      if (!anyMatched) {
        errors.push(err(path, `值不匹配 union 的任何成员；首个原因: ${lastErrors[0]?.message ?? '类型不符'}`, value));
      }
      break;
    case 'fixed':
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') !== node.size) {
        errors.push(err(path, `fixed 字段要求 UTF-8 字节长度为 ${node.size} 的字符串`, value));
      }
      break;
    case 'ref':
      // 递归引用占位：无法展开，做宽松处理并提示
      break;
    case 'any':
      break;
    default:
      errors.push(err(path, `未知 IR 节点类型: ${node.kind}`, value));
  }
}

function checkPrimitive(node, value, path, errors) {
  const ok = (() => {
    switch (node.name) {
      case 'null':
        return value === null;
      case 'string':
      case 'bytes':
        return typeof value === 'string';
      case 'boolean':
        return typeof value === 'boolean';
      case 'int':
        return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
      case 'long':
        return Number.isInteger(value) && Number.isSafeInteger(value);
      case 'float':
      case 'double':
        return typeof value === 'number' && Number.isFinite(value);
      default:
        return true;
    }
  })();
  if (!ok) {
    errors.push(err(path, `期望基础类型 ${node.name}，实际值 ${preview(value)} (${typeName(value)})`, value));
  }
}

function checkRecord(node, value, path, errors, opts) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(err(path, `期望对象，实际为 ${typeName(value)}`, value));
    return;
  }
  const byAlias = new Map();
  if (opts.allowAlias) {
    for (const f of node.fields) {
      for (const a of f.aliases || []) byAlias.set(a, f);
    }
  }

  const presentNames = new Set();
  for (const f of node.fields) {
    const fieldPath = [...path, f.name];
    let rawValue = value[f.name];
    let usedAlias = null;
    if (isMissing(rawValue) && opts.allowAlias && byAlias.size) {
      // 尝试从旧字段名读取
      for (const [alias, target] of byAlias) {
        if (target === f && !isMissing(value[alias])) {
          rawValue = value[alias];
          usedAlias = alias;
          break;
        }
      }
    }
    presentNames.add(f.name);

    if (isMissing(rawValue)) {
      if (f.hasDefault) continue; // 默认值兜底
      if (f.required) {
        errors.push(err(fieldPath, `必填字段缺失（无默认值）`, undefined));
      }
      // 可选且无默认：缺失合法
      continue;
    }
    validateNode(f.type, rawValue, fieldPath, errors, opts);
  }

  // 未知字段：JSON Schema additionalProperties:false / Avro 均拒绝
  const known = new Set([...node.fields.map((f) => f.name), ...(opts.allowAlias ? byAlias.keys() : [])]);
  if (node.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!known.has(key)) {
        errors.push(err([...path, key], `未知字段，结构不允许额外属性 (additionalProperties=false)`, value[key]));
      }
    }
  }
}

function err(path, message, value) {
  return { path: path.length ? joinPath([...path]) : '$', message, value: safeValue(value) };
}

function safeValue(v) {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    return s && s.length > 80 ? JSON.parse(`${s.slice(0, 80)}…"`) : v;
  } catch {
    return String(v);
  }
}

function preview(v) {
  const s = typeof v === 'string' ? `"${v}"` : String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// 浏览器环境没有全局 Buffer，做一个最小替代
const Buffer = globalThis.Buffer || {
  byteLength(str) {
    return new TextEncoder().encode(str).length;
  }
};
