// JSON Schema (Draft-07 风格子集) -> 统一 IR
// 支持: type / 多类型、properties、required、enum、const、default、
//       nullable(显式 null)、array items、嵌套对象、$ref(本地定义)、
//       x-aliases(改名别名)、description/title。

import { unique } from './util.js';

export class SchemaParseError extends Error {
  constructor(message, location) {
    super(location ? `${message} (at ${location})` : message);
    this.name = 'SchemaParseError';
    this.location = location || null;
  }
}

function makeRefResolver(root) {
  // 仅支持本地 #/... 指针；递归自引用产出 ref 占位节点，非自指的真循环才报错
  function resolve(ref, seen) {
    if (!ref.startsWith('#/') && ref !== '#') {
      throw new SchemaParseError(`不支持的外部 $ref: ${ref}`);
    }
    if (seen.has(ref)) {
      return { recursiveRef: ref };
    }
    const next = new Set(seen);
    next.add(ref);
    let node = root;
    if (ref !== '#') {
      for (const seg of ref.slice(2).split('/')) {
        const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
        if (node == null || !(key in node)) {
          throw new SchemaParseError(`$ref 指针无法解析: ${ref}`);
        }
        node = node[key];
      }
    }
    return { node, seen: next };
  }
  return resolve;
}

export function parseJsonSchema(rawSchema) {
  if (rawSchema == null || typeof rawSchema !== 'object' || Array.isArray(rawSchema)) {
    throw new SchemaParseError('JSON Schema 根节点必须是对象');
  }
  const resolveRef = makeRefResolver(rawSchema);

  function convert(node, seenRefs = new Set(), location = '$') {
    if (node === false) {
      // 不允许任何值：用 empty 联合表达
      return { kind: 'union', types: [] };
    }
    if (node === true || node == null) {
      return { kind: 'any' };
    }
    if (typeof node !== 'object') {
      throw new SchemaParseError('Schema 节点必须是对象或布尔值', location);
    }
    if (Array.isArray(node)) {
      throw new SchemaParseError('Schema 节点不能是数组', location);
    }

    if (node.$ref) {
      const resolved = resolveRef(node.$ref, seenRefs);
      if (resolved.recursiveRef) {
        // 合法的递归自引用：输出 ref 占位，避免无限展开
        return { kind: 'ref', name: resolved.recursiveRef };
      }
      const target = convert(resolved.node, resolved.seen, `${location}->${node.$ref}`);
      const merged = { ...target };
      if (node.description) merged.description = node.description;
      if (node['x-aliases']) merged.aliases = toAliasList(node['x-aliases'], location);
      return merged;
    }

    // const 视作单值枚举
    if (Object.prototype.hasOwnProperty.call(node, 'const')) {
      return { kind: 'enum', symbols: [node.const], nullable: false };
    }

    let typeList = node.type;
    if (typeof typeList === 'string') typeList = [typeList];
    if (typeList && !Array.isArray(typeList)) {
      throw new SchemaParseError('type 必须是字符串或数组', location);
    }

    const nullable = Array.isArray(typeList) && typeList.includes('null');
    const nonNullTypes = (typeList || []).filter((t) => t !== 'null');

    // 枚举（type:string + enum 是常见写法，优先按 enum 处理，null 作为可空符号保留）
    if (Array.isArray(node.enum)) {
      if (node.enum.length === 0) throw new SchemaParseError('enum 不能为空', location);
      const hasNullSymbol = node.enum.includes(null);
      const symbols = node.enum.filter((v) => v !== null);
      return {
        kind: 'enum',
        symbols,
        nullable: nullable || hasNullSymbol,
        ...(node.description ? { description: node.description } : {})
      };
    }

    const candidates = nonNullTypes.length ? nonNullTypes : inferTypes(node);

    const converted = candidates.map((t, i) =>
      convertByType(t, node, seenRefs, `${location}.${t}[${i}]`)
    );

    let result;
    if (converted.length === 1) {
      result = converted[0];
    } else if (converted.length === 0) {
      result = { kind: 'any' };
    } else {
      result = { kind: 'union', types: mergeUnions(converted) };
    }
    if (nullable) result.nullable = true;
    if (node.description && result.kind !== 'enum') result.description = node.description;
    return result;
  }

  function inferTypes(node) {
    if (node.properties || node.additionalProperties === false) return ['object'];
    if (node.items) return ['array'];
    // additionalProperties 为 schema 对象时，表达 map<string, T>
    if (node.additionalProperties && typeof node.additionalProperties === 'object') return ['object'];
    return [];
  }

  function convertByType(type, node, seenRefs, location) {
    switch (type) {
      case 'string':
        return { kind: 'primitive', name: 'string' };
      case 'boolean':
        return { kind: 'primitive', name: 'boolean' };
      case 'integer':
        return { kind: 'primitive', name: 'long' }; // 跨格式归一：integer -> long
      case 'number':
        return { kind: 'primitive', name: 'double' };
      case 'array': {
        if (!node.items) return { kind: 'array', items: { kind: 'any' } };
        if (Array.isArray(node.items)) {
          // tuple：取首项并提示（本实现按首项类型处理）
          return { kind: 'array', items: convert(node.items[0] ?? true, seenRefs, `${location}.items`) };
        }
        return { kind: 'array', items: convert(node.items, seenRefs, `${location}.items`) };
      }
      case 'object':
        return convertObject(node, seenRefs, location);
      default:
        throw new SchemaParseError(`不支持的 JSON Schema 类型: ${type}`, location);
    }
  }

  function convertObject(node, seenRefs, location) {
    const props = node.properties || {};
    const requiredList = new Set(node.required || []);
    const fields = Object.entries(props).map(([name, sub]) => {
      const subLoc = `${location}.properties.${name}`;
      const field = {
        name,
        type: convert(sub, new Set(seenRefs), subLoc),
        required: requiredList.has(name),
        nullable: false,
        hasDefault: Object.prototype.hasOwnProperty.call(sub, 'default'),
        ...(sub.description ? { description: sub.description } : {})
      };
      // 别名可能声明在属性节点本身，也可能声明在其 $ref 解析结果上
      const aliasValues = [];
      if (sub && sub['x-aliases']) aliasValues.push(...toAliasList(sub['x-aliases'], subLoc));
      if (field.type && field.type.aliases) aliasValues.push(...field.type.aliases);
      if (aliasValues.length) field.aliases = unique(aliasValues);
      if (sub && sub.default !== undefined) field.default = sub.default;
      return field;
    });

    // 无具名属性、仅 additionalProperties 为 schema 时，表达 map<string, T>
    if (fields.length === 0 && node.additionalProperties && typeof node.additionalProperties === 'object') {
      return {
        kind: 'map',
        values: convert(node.additionalProperties, new Set(seenRefs), `${location}.additionalProperties`)
      };
    }

    return {
      kind: 'record',
      fields,
      additionalProperties: node.additionalProperties !== false
    };
  }

  const rootType = convert(rawSchema);
  return {
    format: 'json-schema',
    root: rootType,
    title: rawSchema.title || null,
    description: rawSchema.description || '',
    dialect: rawSchema.$schema || null
  };
}

function toAliasList(value, location) {
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((v) => typeof v === 'string' && v.length)) {
    throw new SchemaParseError('x-aliases 必须是非空字符串或其数组', location);
  }
  return unique(list);
}

function mergeUnions(types) {
  const flat = [];
  for (const t of types) {
    if (t.kind === 'union') flat.push(...t.types);
    else flat.push(t);
  }
  return flat;
}
