import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonSchema } from '../src/core/parseJsonSchema.js';
import { parseAvro } from '../src/core/parseAvro.js';
import { validateSample, validateOldSampleAgainstNew } from '../src/core/validate.js';

test('合法样例通过', () => {
  const ir = parseJsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['id', 'tags'],
    properties: {
      id: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } }
    }
  });
  const r = validateSample(ir, { id: 'x', tags: ['a', 'b'] });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('坏样例定位到嵌套字段路径', () => {
  const ir = parseJsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['order'],
    properties: {
      order: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['qty'],
              properties: { qty: { type: 'integer' } }
            }
          }
        }
      }
    }
  });
  const r = validateSample(ir, { order: { items: [{ qty: 3 }, { qty: 'bad' }] } });
  assert.equal(r.valid, false);
  const nested = r.errors.find((e) => e.path === 'order.items.[1].qty');
  assert.ok(nested, '应定位到数组下标 1 的嵌套字段');
  assert.match(nested.message, /long|integer/);
});

test('必填缺失、枚举非法、未知字段、null 非空分别报错', () => {
  const ir = parseJsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['A', 'B'] },
      note: { type: 'string' }
    }
  });
  const r = validateSample(ir, { status: 'C', note: null, ghost: 1 });
  const paths = r.errors.map((e) => e.path);
  assert.ok(paths.includes('id'), '必填缺失');
  assert.ok(paths.includes('status'), '枚举非法');
  assert.ok(paths.includes('note'), '给非空字段传 null');
  assert.ok(paths.includes('ghost'), 'additionalProperties=false 下的未知字段');
});

test('可空字段接受 null，默认值使缺失合法', () => {
  const ir = parseJsonSchema({
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      note: { type: ['string', 'null'] },
      zone: { type: 'string', default: 'cn' }
    }
  });
  const r = validateSample(ir, { id: 'x', note: null });
  assert.equal(r.valid, true);
});

test('Avro 样本：union 匹配与 int 范围检查', () => {
  const ir = parseAvro({
    type: 'record',
    name: 'R',
    fields: [
      { name: 'v', type: ['null', 'int'], 'default': null },
      { name: 's', type: 'string' }
    ]
  });
  assert.equal(validateSample(ir, { v: null, s: 'x' }).valid, true);
  assert.equal(validateSample(ir, { v: 12, s: 'x' }).valid, true);
  const bad = validateSample(ir, { v: 9999999999, s: 'x' });
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0].message, /int/);
});

test('改名别名：旧数据用旧字段名仍可通过新结构校验', () => {
  const newIr = parseJsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['fullName'],
    properties: {
      fullName: { type: 'string', 'x-aliases': ['name'] }
    }
  });
  const oldData = { name: 'Alice' };
  const normal = validateSample(newIr, oldData);
  assert.equal(normal.valid, false, '普通校验不接受旧字段名');

  const aliasCheck = validateOldSampleAgainstNew(newIr, oldData);
  assert.equal(aliasCheck.valid, true);
  assert.equal(aliasCheck.aliasReadable, true);

  const broken = validateOldSampleAgainstNew(newIr, { other: 1 });
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.some((e) => e.path === 'fullName'));
});

test('嵌套改名：别名在嵌套 record 中同样生效', () => {
  const newIr = parseJsonSchema({
    type: 'object',
    required: ['addr'],
    properties: {
      addr: {
        type: 'object',
        additionalProperties: false,
        required: ['cityName'],
        properties: { cityName: { type: 'string', 'x-aliases': ['city'] } }
      }
    }
  });
  const r = validateOldSampleAgainstNew(newIr, { addr: { city: 'Beijing' } });
  assert.equal(r.valid, true);
});

test('枚举中的 null 符号使该枚举可空', () => {
  const ir = parseJsonSchema({
    type: 'object',
    required: ['s'],
    properties: { s: { type: ['string', 'null'], enum: ['A', null] } }
  });
  assert.equal(validateSample(ir, { s: null }).valid, true);
  assert.equal(validateSample(ir, { s: 'B' }).valid, false);
});

test('additionalProperties 为 schema 时按 map 校验并定位键路径', () => {
  const ir = parseJsonSchema({
    type: 'object',
    required: ['m'],
    properties: { m: { type: 'object', additionalProperties: { type: 'integer' } } }
  });
  assert.equal(ir.root.fields[0].type.kind, 'map');
  const r = validateSample(ir, { m: { a: 1, b: 'bad' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === 'm.{b}'));
});
