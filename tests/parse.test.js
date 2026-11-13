import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJsonSchema, SchemaParseError } from '../src/core/parseJsonSchema.js';
import { parseAvro, AvroParseError } from '../src/core/parseAvro.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, 'fixtures', name);
const load = async (name) => JSON.parse(await readFile(fx(name), 'utf8'));

test('JSON Schema: 可选/必填/可空/默认值解析为三个正交标记', async () => {
  const ir = parseJsonSchema(await load('order.v1.json'));
  assert.equal(ir.format, 'json-schema');
  const root = ir.root;
  assert.equal(root.kind, 'record');
  const byName = new Map(root.fields.map((f) => [f.name, f]));

  assert.equal(byName.get('orderId').required, true);
  assert.equal(byName.get('orderId').hasDefault, false);

  assert.equal(byName.get('currency').required, false);
  assert.equal(byName.get('currency').hasDefault, true);
  assert.equal(byName.get('currency').default, 'CNY');

  // remark: ["string","null"] -> 可空但仍可选，且无默认值
  const remark = byName.get('remark');
  assert.equal(remark.required, false);
  assert.equal(remark.type.nullable, true);
  assert.equal(remark.hasDefault, false);

  // 嵌套 record
  const items = byName.get('items');
  assert.equal(items.type.kind, 'array');
  assert.equal(items.type.items.kind, 'record');
  const qty = items.type.items.fields.find((f) => f.name === 'qty');
  assert.equal(qty.type.name, 'long'); // integer 归一为 long
});

test('JSON Schema: x-aliases 被解析到字段上', async () => {
  const ir = parseJsonSchema(await load('order.v2.json'));
  const orderNo = ir.root.fields.find((f) => f.name === 'orderNo');
  assert.deepEqual(orderNo.aliases, ['orderId']);
});

test('JSON Schema: 非法定义抛出带定位的错误', () => {
  assert.throws(
    () => parseJsonSchema({ type: 'object', properties: { x: { type: 'weird' } } }),
    (e) => e instanceof SchemaParseError && /weird/.test(e.message)
  );
  assert.throws(() => parseJsonSchema('nope'), SchemaParseError);
});

test('JSON Schema: 本地 $ref 解析与循环检测', () => {
  const tree = {
    type: 'object',
    definitions: {
      node: {
        type: 'object',
        properties: {
          child: { $ref: '#/definitions/node' }
        }
      }
    },
    properties: { root: { $ref: '#/definitions/node' } }
  };
  const ir = parseJsonSchema(tree);
  assert.equal(ir.root.kind, 'record');
  assert.throws(
    () => parseJsonSchema({ type: 'object', properties: { a: { $ref: '#/missing/x' } } }),
    SchemaParseError
  );
});

test('Avro: union null 解析为 nullable，默认值与必填独立', async () => {
  const ir = parseAvro(await load('user.avro.v1.json'));
  assert.equal(ir.format, 'avro');
  const score = ir.root.fields.find((f) => f.name === 'score');
  assert.equal(score.type.kind, 'primitive'); // 单成员 union 拍平
  assert.equal(score.type.name, 'int');
  assert.equal(score.type.nullable, true);
  assert.equal(score.required, false); // 有 default
  assert.equal(score.hasDefault, true);
  assert.equal(score.default, null);

  const id = ir.root.fields.find((f) => f.name === 'id');
  assert.equal(id.required, true);
  assert.equal(id.hasDefault, false);
  assert.equal(id.type.name, 'long');

  // 嵌套 record 在 ["null", record] 单成员 union 中被拍平为可空 record
  const address = ir.root.fields.find((f) => f.name === 'address');
  assert.equal(address.type.kind, 'record');
  assert.equal(address.type.nullable, true);
  const rec = address.type;
  const city = rec.fields.find((f) => f.name === 'city');
  assert.equal(city.required, true);
});

test('Avro: 字段 aliases 与命名类型引用', async () => {
  const ir = parseAvro(await load('user.avro.v2.json'));
  const fullName = ir.root.fields.find((f) => f.name === 'fullName');
  assert.deepEqual(fullName.aliases, ['name']);
  const tier = ir.root.fields.find((f) => f.name === 'tier');
  assert.equal(tier.type.kind, 'enum');
  assert.deepEqual(tier.type.symbols, ['FREE', 'PRO', 'ENTERPRISE']);
});

test('Avro: 缺 type 的字段抛出错误并保留位置', async () => {
  const broken = await load('broken.avro.json');
  assert.throws(
    () => parseAvro(broken),
    (e) => e instanceof AvroParseError && /fields\[0\]/.test(e.message)
  );
});

test('Avro: 无法解析的命名引用报错', () => {
  assert.throws(
    () => parseAvro({ type: 'record', name: 'R', fields: [{ name: 'x', type: 'Ghost' }] }),
    AvroParseError
  );
});
