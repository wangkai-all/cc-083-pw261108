import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonSchema } from '../src/core/parseJsonSchema.js';
import { parseAvro } from '../src/core/parseAvro.js';
import { compareContracts, VERDICT } from '../src/core/schemaCompare.js';

const obj = (props, required = [], extra = {}) => ({
  type: 'object',
  additionalProperties: false,
  properties: props,
  required,
  ...extra
});

function kindsOf(result) {
  return result.changes.map((c) => `${c.path}:${c.kind}`);
}

test('新增可选字段：向后通过、向前有条件、消费者有条件', () => {
  const oldIr = parseJsonSchema(obj({ a: { type: 'string' } }, ['a']));
  const newIr = parseJsonSchema(obj({ a: { type: 'string' }, b: { type: 'integer' } }, ['a']));
  const r = compareContracts(oldIr, newIr);
  const change = r.changes.find((c) => c.kind === 'added-optional');
  assert.ok(change);
  assert.equal(change.directions.backward.verdict, VERDICT.PASS);
  assert.equal(change.directions.forward.verdict, VERDICT.CONDITIONAL);
  assert.equal(change.directions.consumer.verdict, VERDICT.CONDITIONAL);
  assert.equal(r.summary.backward, VERDICT.PASS);
});

test('新增无默认必填字段：向后不通过', () => {
  const oldIr = parseJsonSchema(obj({ a: { type: 'string' } }, ['a']));
  const newIr = parseJsonSchema(obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']));
  const r = compareContracts(oldIr, newIr);
  const change = r.changes.find((c) => c.kind === 'added-required');
  assert.equal(change.directions.backward.verdict, VERDICT.FAIL);
  assert.equal(change.directions.forward.verdict, VERDICT.CONDITIONAL);
  assert.equal(r.summary.backward, VERDICT.FAIL);
});

test('新增带默认值必填字段与普通可选分开归类', () => {
  const oldIr = parseJsonSchema(obj({ a: { type: 'string' } }, ['a']));
  const newIr = parseJsonSchema(
    obj(
      {
        a: { type: 'string' },
        b: { type: 'string', default: 'x' },
        c: { type: 'string' }
      },
      ['a', 'b']
    )
  );
  const r = compareContracts(oldIr, newIr);
  assert.ok(r.changes.some((c) => c.kind === 'added-required-with-default'));
  assert.ok(r.changes.some((c) => c.kind === 'added-optional'));
});

test('删除必填字段：向前不通过；删除可选字段向后只是有条件', () => {
  const oldIr = parseJsonSchema(
    obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b'])
  );
  const newIrReq = parseJsonSchema(obj({ a: { type: 'string' } }, ['a']));
  const r1 = compareContracts(oldIr, newIrReq);
  const removed = r1.changes.find((c) => c.kind === 'removed-required');
  assert.equal(removed.directions.forward.verdict, VERDICT.FAIL);
  assert.equal(removed.directions.backward.verdict, VERDICT.CONDITIONAL);

  const oldOpt = parseJsonSchema(obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a']));
  const r2 = compareContracts(oldOpt, newIrReq);
  assert.ok(r2.changes.some((c) => c.kind === 'removed-optional'));
  assert.equal(r2.changes[0].directions.forward.verdict, VERDICT.PASS);
});

test('收窄类型向后不通过、放宽类型向前不通过，方向不可混淆', () => {
  const wide = parseJsonSchema(obj({ v: { type: 'number' } }, ['v'])); // double
  const narrow = parseJsonSchema(obj({ v: { type: 'integer' } }, ['v'])); // long

  const narrowing = compareContracts(wide, narrow);
  const n = narrowing.changes.find((c) => c.kind === 'type-narrowed');
  assert.ok(n, '应识别为类型收窄');
  assert.equal(n.directions.backward.verdict, VERDICT.FAIL);
  assert.equal(n.directions.forward.verdict, VERDICT.PASS);

  const widening = compareContracts(narrow, wide);
  const w = widening.changes.find((c) => c.kind === 'type-widened');
  assert.ok(w, '应识别为类型放宽');
  assert.equal(w.directions.backward.verdict, VERDICT.PASS);
  assert.equal(w.directions.forward.verdict, VERDICT.FAIL);
});

test('int 与 long 同宽，不产生类型变更', () => {
  const intIr = parseAvro({ type: 'record', name: 'R', fields: [{ name: 'v', type: 'int' }] });
  const longIr = parseAvro({ type: 'record', name: 'R', fields: [{ name: 'v', type: 'long' }] });
  const r = compareContracts(intIr, longIr);
  assert.equal(r.changeCount, 0);
});

test('string -> boolean 属于类型族变化，双向不通过', () => {
  const oldIr = parseJsonSchema(obj({ v: { type: 'string' } }, ['v']));
  const newIr = parseJsonSchema(obj({ v: { type: 'boolean' } }, ['v']));
  const r = compareContracts(oldIr, newIr);
  const c = r.changes.find((x) => x.kind === 'type-changed');
  assert.equal(c.directions.backward.verdict, VERDICT.FAIL);
  assert.equal(c.directions.forward.verdict, VERDICT.FAIL);
});

test('枚举加值向前不通过、枚举删值向后不通过', () => {
  const oldIr = parseJsonSchema(obj({ s: { type: 'string', enum: ['A', 'B'] } }, ['s']));
  const added = parseJsonSchema(obj({ s: { type: 'string', enum: ['A', 'B', 'C'] } }, ['s']));
  const rAdd = compareContracts(oldIr, added);
  const addChange = rAdd.changes.find((c) => c.kind === 'enum-symbol-added');
  assert.equal(addChange.directions.backward.verdict, VERDICT.PASS);
  assert.equal(addChange.directions.forward.verdict, VERDICT.FAIL);

  const removed = parseJsonSchema(obj({ s: { type: 'string', enum: ['A'] } }, ['s']));
  const rRem = compareContracts(oldIr, removed);
  const remChange = rRem.changes.find((c) => c.kind === 'enum-symbol-removed');
  assert.equal(remChange.directions.backward.verdict, VERDICT.FAIL);
  assert.equal(remChange.directions.forward.verdict, VERDICT.PASS);
});

test('可选、可空、默认值是三个独立维度，分别产生变更', () => {
  const oldIr = parseJsonSchema(
    obj(
      {
        a: { type: ['string', 'null'], default: 'x' }
      },
      ['a']
    )
  );
  const newIr = parseJsonSchema(
    obj(
      {
        a: { type: 'string', default: 'y' } // 必填(required保留)、去掉可空、默认值变化
      },
      ['a']
    )
  );
  const r = compareContracts(oldIr, newIr);
  const kinds = r.changes.map((c) => c.kind);
  assert.ok(kinds.includes('nullable-to-non'), '应有可空性变更');
  assert.ok(kinds.includes('default-changed'), '应有默认值变更');
  // required 未变（两边都在 required 列表），不应出现必填性变更
  assert.ok(!kinds.includes('optional-to-required'));
});

test('必填改可选与可选改必填方向相反', () => {
  const oldIr = parseJsonSchema(obj({ a: { type: 'string' } }, ['a']));
  const relaxed = parseJsonSchema(obj({ a: { type: 'string' } }, []));
  const r1 = compareContracts(oldIr, relaxed);
  assert.equal(r1.changes.find((c) => c.kind === 'required-to-optional').directions.backward.verdict, VERDICT.PASS);

  const r2 = compareContracts(relaxed, oldIr);
  assert.equal(r2.changes.find((c) => c.kind === 'optional-to-required').directions.backward.verdict, VERDICT.CONDITIONAL);
});

test('改名无别名=双向不通过；有别名未验证=消费者不通过；样例验证后升级为通过', () => {
  const oldIr = parseJsonSchema(obj({ a: { type: 'string' } }, ['a']));
  const renamedNoAlias = parseJsonSchema(obj({ b: { type: 'string' } }, ['b']));
  const r0 = compareContracts(oldIr, renamedNoAlias);
  assert.ok(r0.changes.some((c) => c.kind === 'renamed-no-alias'));
  assert.equal(r0.summary.overall, VERDICT.FAIL);

  const renamedWithAlias = parseJsonSchema(
    obj({ b: { type: 'string', 'x-aliases': ['a'] } }, ['b'])
  );
  const r1 = compareContracts(oldIr, renamedWithAlias);
  const unverified = r1.changes.find((c) => c.kind === 'renamed-alias-unverified');
  assert.ok(unverified);
  assert.equal(unverified.directions.consumer.verdict, VERDICT.FAIL);
  assert.equal(r1.summary.overall, VERDICT.FAIL, '未验证别名不能给出通过结论');

  const r2 = compareContracts(oldIr, renamedWithAlias, { verifiedRenames: new Set(['b']) });
  const verified = r2.changes.find((c) => c.kind === 'renamed-alias-verified');
  assert.equal(verified.directions.backward.verdict, VERDICT.PASS);
  assert.notEqual(r2.summary.overall, VERDICT.FAIL);
});

test('嵌套字段变更携带完整路径', () => {
  const oldIr = parseJsonSchema(
    obj(
      {
        order: obj(
          { items: { type: 'array', items: obj({ sku: { type: 'string' }, qty: { type: 'integer' } }, ['sku', 'qty']) } },
          ['items']
        )
      },
      ['order']
    )
  );
  const newIr = parseJsonSchema(
    obj(
      {
        order: obj(
          { items: { type: 'array', items: obj({ sku: { type: 'string' }, qty: { type: 'number' } }, ['sku', 'qty']) } },
          ['items']
        )
      },
      ['order']
    )
  );
  const r = compareContracts(oldIr, newIr);
  const c = r.changes.find((x) => x.kind === 'type-widened');
  assert.equal(c.path, 'order.items.[].qty');
});

test('跨格式比较：Avro record 与 JSON Schema record 可在统一 IR 上比较', () => {
  const avroIr = parseAvro({
    type: 'record',
    name: 'R',
    fields: [
      { name: 'id', type: 'string' },
      { name: 'n', type: 'int' }
    ]
  });
  const jsonIr = parseJsonSchema(
    obj({ id: { type: 'string' }, n: { type: 'integer' }, extra: { type: 'boolean' } }, ['id', 'n'])
  );
  const r = compareContracts(avroIr, jsonIr);
  assert.ok(r.changes.some((c) => c.kind === 'added-optional' && c.path === 'extra'));
  assert.equal(r.summary.backward, VERDICT.PASS);
});

test('跨类型族（string -> integer）判类型族变化，而不是宽度放宽', () => {
  const oldIr = parseJsonSchema(obj({ v: { type: ['string', 'null'] } }, ['v']));
  const newIr = parseJsonSchema(obj({ v: { type: ['integer', 'null'] } }, ['v']));
  const r = compareContracts(oldIr, newIr);
  assert.ok(r.changes.some((c) => c.kind === 'type-changed'));
  assert.ok(!r.changes.some((c) => c.kind === 'type-widened'));
});

test('字段可空性变化只上报一次，且嵌套 record 内路径正确', () => {
  const oldIr = parseJsonSchema(obj({ v: { type: 'string' } }, ['v']));
  const newIr = parseJsonSchema(obj({ v: { type: ['string', 'null'] } }, ['v']));
  const r1 = compareContracts(oldIr, newIr);
  assert.equal(r1.changes.filter((c) => c.kind === 'non-to-nullable').length, 1);

  const nestedOld = parseJsonSchema(
    obj({ a: obj({ x: { type: 'string' } }, ['x']) }, ['a'])
  );
  const nestedNew = parseJsonSchema(
    obj({ a: obj({ x: { type: ['string', 'null'] } }, ['x']) }, ['a'])
  );
  const r2 = compareContracts(nestedOld, nestedNew);
  const nullableChanges = r2.changes.filter((c) => c.kind === 'non-to-nullable');
  assert.equal(nullableChanges.length, 1);
  assert.equal(nullableChanges[0].path, 'a.x');
});

test('数组元素的可空性变化在非字段包装路径也能识别', () => {
  const oldIr = parseJsonSchema(
    obj({ l: { type: 'array', items: { type: 'string' } } }, ['l'])
  );
  const newIr = parseJsonSchema(
    obj({ l: { type: 'array', items: { type: ['string', 'null'] } } }, ['l'])
  );
  const r = compareContracts(oldIr, newIr);
  assert.ok(r.changes.some((c) => c.kind === 'non-to-nullable' && c.path === 'l.[]'));
});

test('变更的 detail 必须注入三方向结论文案（非 undefined 占位）', () => {
  const oldIr = parseJsonSchema(obj(
    { s: { type: 'string', enum: ['A'] }, c: { type: 'string', default: 'X' } }, ['s', 'c']
  ));
  const newIr = parseJsonSchema(obj(
    { s: { type: 'string', enum: ['A', 'B'] }, c: { type: 'string', default: 'Y' } }, ['s', 'c']
  ));
  const r = compareContracts(oldIr, newIr);
  const enumChange = r.changes.find((c) => c.kind === 'enum-symbol-added');
  assert.ok(enumChange.directions.forward.reason.includes('B'));
  assert.ok(!r.changes.some((c) => JSON.stringify(c.directions).includes('undefined')));
  const defaultChange = r.changes.find((c) => c.kind === 'default-changed');
  assert.ok(defaultChange.directions.backward.reason.includes('X'));
});
