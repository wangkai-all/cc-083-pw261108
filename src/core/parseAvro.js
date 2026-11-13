// Avro 1.11 规范子集 -> 统一 IR
// 支持: 基础类型、record(含 namespace/aliases/doc)、enum、array、map、fixed、
//       union(含 null 可空判定)、命名类型引用、字段 default/aliases/doc、
//       logicalType(仅作元信息保留，不参与兼容判定)。

import { unique } from './util.js';

export class AvroParseError extends Error {
  constructor(message, location) {
    super(location ? `${message} (at ${location})` : message);
    this.name = 'AvroParseError';
    this.location = location || null;
  }
}

const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);

export function parseAvro(rawSchema) {
  if (rawSchema == null || typeof rawSchema !== 'object') {
    throw new AvroParseError('Avro Schema 根节点必须是对象或类型字符串');
  }
  const named = new Map(); // 全名 -> 原始 schema 对象

  function qualifyName(name, namespace) {
    if (name.includes('.')) return name;
    return namespace ? `${namespace}.${name}` : name;
  }

  function registerNamed(node, namespace, location) {
    if (!node.name || typeof node.name !== 'string') {
      throw new AvroParseError('命名类型缺少 name', location);
    }
    const full = qualifyName(node.name, node.namespace ?? namespace);
    if (named.has(full) && named.get(full) !== node) {
      throw new AvroParseError(`命名类型重复定义: ${full}`, location);
    }
    named.set(full, node);
    return full;
  }

  function resolveName(ref, namespace, location) {
    if (PRIMITIVES.has(ref)) return null;
    if (named.has(ref)) return named.get(ref);
    if (namespace) {
      const qualified = `${namespace}.${ref}`;
      if (named.has(qualified)) return named.get(qualified);
    }
    const byShort = [...named.values()].find((s) => s.name === ref);
    if (byShort) return byShort;
    throw new AvroParseError(`无法解析的命名类型引用: ${ref}`, location);
  }

  function convert(schema, namespace, location, seen = new Set()) {
    // union
    if (Array.isArray(schema)) {
      if (schema.length === 0) throw new AvroParseError('union 不能为空', location);
      const hasNull = schema.some((s) => s === 'null');
      const members = schema.filter((s) => s !== 'null');
      if (members.length === 0) {
        return { kind: 'primitive', name: 'null', nullable: true };
      }
      const converted = members.map((m, i) => convert(m, namespace, `${location}[${i}]`, seen));
      const base = converted.length === 1 ? converted[0] : { kind: 'union', types: converted };
      // 可空性落到实际成员上（单成员 union 在 Avro 里等价于可空的该类型）
      if (hasNull) base.nullable = true;
      return base;
    }

    // 类型名引用 / 基础类型
    if (typeof schema === 'string') {
      if (PRIMITIVES.has(schema)) return { kind: 'primitive', name: schema };
      const target = resolveName(schema, namespace, location);
      if (seen.has(target)) {
        // 递归命名引用：输出带名字的占位记录，避免无限展开
        return { kind: 'ref', name: qualifyName(schema, namespace) };
      }
      return convert(target, namespace, location, new Set(seen).add(target));
    }

    if (typeof schema !== 'object') {
      throw new AvroParseError('非法 schema 节点', location);
    }

    const { type } = schema;
    if (typeof type !== 'string') {
      throw new AvroParseError('schema 对象缺少字符串 type', location);
    }

    switch (type) {
      case 'record': {
        const full = registerNamed(schema, namespace, location);
        if (seen.has(schema)) return { kind: 'ref', name: full };
        const nextSeen = new Set(seen).add(schema);
        if (!Array.isArray(schema.fields)) {
          throw new AvroParseError(`record ${full} 缺少 fields 数组`, location);
        }
        const fields = schema.fields.map((f, i) => {
          const floc = `${location}.fields[${i}]`;
          if (!f || typeof f !== 'object' || !f.name) {
            throw new AvroParseError('字段缺少 name', floc);
          }
          const fieldType = convert(f.type, schema.namespace ?? namespace, `${floc}.type`, nextSeen);
          const field = {
            name: f.name,
            type: fieldType,
            // Avro 字段在结构上总存在；无 default 即读取时必填
            required: !Object.prototype.hasOwnProperty.call(f, 'default'),
            nullable: fieldType.nullable === true,
            hasDefault: Object.prototype.hasOwnProperty.call(f, 'default'),
            ...(f.doc ? { description: f.doc } : {})
          };
          if (Object.prototype.hasOwnProperty.call(f, 'default')) field.default = f.default;
          if (f.aliases) field.aliases = checkAliases(f.aliases, floc);
          return field;
        });
        const node = {
          kind: 'record',
          recordName: full,
          fields,
          additionalProperties: false,
          ...(schema.aliases ? { aliases: checkAliases(schema.aliases, location) } : {}),
          ...(schema.doc ? { description: schema.doc } : {})
        };
        return node;
      }
      case 'enum': {
        registerNamed(schema, namespace, location);
        if (!Array.isArray(schema.symbols) || schema.symbols.length === 0) {
          throw new AvroParseError('enum 缺少非空 symbols', location);
        }
        if (!schema.symbols.every((s) => typeof s === 'string')) {
          throw new AvroParseError('enum symbols 必须全为字符串', location);
        }
        return {
          kind: 'enum',
          enumName: qualifyName(schema.name, schema.namespace ?? namespace),
          symbols: [...schema.symbols],
          nullable: false,
          ...(schema.default !== undefined ? { enumDefault: schema.default } : {}),
          ...(schema.aliases ? { aliases: checkAliases(schema.aliases, location) } : {}),
          ...(schema.doc ? { description: schema.doc } : {})
        };
      }
      case 'array':
        if (schema.items === undefined) throw new AvroParseError('array 缺少 items', location);
        return { kind: 'array', items: convert(schema.items, namespace, `${location}.items`, seen) };
      case 'map':
        if (schema.values === undefined) throw new AvroParseError('map 缺少 values', location);
        return { kind: 'map', values: convert(schema.values, namespace, `${location}.values`, seen) };
      case 'fixed':
        registerNamed(schema, namespace, location);
        return {
          kind: 'fixed',
          fixedName: qualifyName(schema.name, schema.namespace ?? namespace),
          size: schema.size,
          ...(schema.logicalType ? { logicalType: schema.logicalType } : {})
        };
      default:
        if (PRIMITIVES.has(type)) {
          const node = { kind: 'primitive', name: type };
          if (schema.logicalType) node.logicalType = schema.logicalType;
          return node;
        }
        // type 也可能是命名类型名
        const target = resolveName(type, namespace, location);
        return convert(target, namespace, location, seen);
    }
  }

  const root = convert(rawSchema, rawSchema.namespace, '$');
  return {
    format: 'avro',
    root,
    title: typeof rawSchema.name === 'string' ? rawSchema.name : null,
    description: rawSchema.doc || ''
  };
}

function checkAliases(value, location) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length)) {
    throw new AvroParseError('aliases 必须是非空字符串数组', location);
  }
  return unique(value);
}
