import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ContractRegistry,
  VersionConflictError,
  VERSION_STATUS
} from '../src/core/registry.js';
import { MemoryStorage } from '../src/core/storage.js';
import { buildReport, reportToMarkdown, reportToJson } from '../src/core/report.js';
import { VERDICT } from '../src/core/schemaCompare.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, 'fixtures', name);
const loadText = (name) => readFile(fx(name), 'utf8');
const load = async (name) => JSON.parse(await loadText(name));

async function freshRegistry() {
  const reg = new ContractRegistry(new MemoryStorage());
  const ds = reg.createDataset({ name: '订单事件', owner: 'data-team' });
  return { reg, ds };
}

test('完整导入流程：JSON Schema 两版本并发布，历史可比较', async () => {
  const { reg, ds } = await freshRegistry();
  const v1Text = await loadText('order.v1.json');
  const v2Text = await loadText('order.v2.json');

  const imp1 = await reg.importDefinition({
    datasetId: ds.id, version: '1.0.0', fileName: 'order.v1.json', text: v1Text
  });
  assert.equal(imp1.status, 'imported');
  assert.equal(imp1.version.status, VERSION_STATUS.DRAFT);

  const imp2 = await reg.importDefinition({
    datasetId: ds.id, version: '1.1.0', fileName: 'order.v2.json', text: v2Text
  });
  assert.equal(imp2.status, 'imported');

  reg.publishVersion(ds.id, imp1.version.id);
  reg.publishVersion(ds.id, imp2.version.id);

  const stored = reg.getDataset(ds.id);
  assert.equal(stored.versions.length, 2);
  assert.ok(stored.versions.every((v) => v.status === VERSION_STATUS.PUBLISHED));

  const cmp = reg.compareVersions(ds.id, imp1.version.id, imp2.version.id);
  assert.equal(cmp.notEvaluated, false);
  const kinds = cmp.changes.map((c) => c.kind);
  // v1->v2 覆盖：新增必填 channel、枚举加值、可空收紧、默认值变化、类型收窄、改名
  assert.ok(kinds.includes('added-required'));
  assert.ok(kinds.includes('enum-symbol-added'));
  assert.ok(kinds.includes('nullable-to-non'));
  assert.ok(kinds.includes('default-changed'));
  assert.ok(kinds.includes('type-narrowed'));
  assert.ok(kinds.includes('renamed-alias-unverified'));
  assert.equal(cmp.summary.overall, VERDICT.FAIL);
});

test('同版本号同内容幂等；同版本号不同内容拒绝覆盖', async () => {
  const { reg, ds } = await freshRegistry();
  const text = await loadText('order.v1.json');
  const first = await reg.importDefinition({ datasetId: ds.id, version: '1.0.0', fileName: 'a.json', text });
  const again = await reg.importDefinition({ datasetId: ds.id, version: '1.0.0', fileName: 'a.json', text });
  assert.equal(again.status, 'duplicated');
  assert.equal(again.version.id, first.version.id);
  assert.equal(reg.getDataset(ds.id).versions.length, 1);

  // 键序与空白不同、但逻辑结构相同：指纹一致，仍判幂等
  const reordered = JSON.stringify(Object.fromEntries(
    Object.entries(JSON.parse(text)).reverse()
  ), null, 4);
  const sameContent = await reg.importDefinition({
    datasetId: ds.id, version: '1.0.0', fileName: 'a.json', text: reordered
  });
  assert.equal(sameContent.status, 'duplicated');
  assert.equal(reg.getDataset(ds.id).versions.length, 1);

  const modified = JSON.stringify({ ...JSON.parse(text), title: 'Tampered' });
  await assert.rejects(
    reg.importDefinition({ datasetId: ds.id, version: '1.0.0', fileName: 'b.json', text: modified }),
    (e) => e instanceof VersionConflictError && e.code === 'VERSION_CONFLICT'
  );
  assert.equal(reg.getDataset(ds.id).versions.length, 1, '冲突时不得写入');
});

test('解析失败：原始文件保留、状态未评估、不参与比较与发布', async () => {
  const { reg, ds } = await freshRegistry();

  const syntaxBad = await loadText('broken-syntax.json.txt');
  const r1 = await reg.importDefinition({
    datasetId: ds.id, version: '0.1.0', fileName: 'broken-syntax.json.txt', text: syntaxBad
  });
  assert.equal(r1.status, 'unevaluated');
  assert.equal(r1.version.status, VERSION_STATUS.UNEVALUATED);
  assert.equal(r1.version.rawText, syntaxBad, '原始文件必须保留');
  assert.ok(r1.version.parseError.message);
  assert.equal(r1.version.ir, null);

  const avroBad = JSON.stringify(await load('broken.avro.json'));
  const r2 = await reg.importDefinition({
    datasetId: ds.id, version: '0.2.0', fileName: 'broken.avro.json', text: avroBad
  });
  assert.equal(r2.status, 'unevaluated');
  assert.equal(r2.version.parseError.stage, 'schema-parse');
  assert.ok(r2.version.parseError.location);

  const good = await reg.importDefinition({
    datasetId: ds.id, version: '1.0.0', fileName: 'order.v1.json', text: await loadText('order.v1.json')
  });

  // 未评估版本不能发布
  assert.throws(() => reg.publishVersion(ds.id, r1.version.id), /未评估/);

  // 未解析定义不参与通过结论
  const cmp = reg.compareVersions(ds.id, r1.version.id, good.version.id);
  assert.equal(cmp.notEvaluated, true);
  assert.match(cmp.reason, /不参与/);

  // 样本校验同样拒绝
  const sv = reg.validateSample(ds.id, r2.version.id, '{}');
  assert.equal(sv.notEvaluated, true);
});

test('Avro 导入、别名样例验证驱动改名结论升级', async () => {
  const { reg, ds } = await freshRegistry();
  const v1 = await reg.importDefinition({
    datasetId: ds.id, version: '1.0.0', fileName: 'user.avro.v1.json', text: await loadText('user.avro.v1.json')
  });
  const v2 = await reg.importDefinition({
    datasetId: ds.id, version: '2.0.0', fileName: 'user.avro.v2.json', text: await loadText('user.avro.v2.json')
  });

  const before = reg.compareVersions(ds.id, v1.version.id, v2.version.id);
  assert.ok(before.changes.some((c) => c.kind === 'renamed-alias-unverified'));

  // 旧样例数据使用旧字段名 name
  const oldSample = JSON.stringify({
    id: 1,
    name: 'Bob',
    tier: 'FREE',
    score: null,
    address: null
  });
  const verification = reg.verifyRenameWithOldSample(
    ds.id, v1.version.id, v2.version.id, oldSample
  );
  assert.equal(verification.valid, true);
  assert.ok(verification.verifiedPaths.includes('fullName'));

  const after = reg.compareVersions(
    ds.id, v1.version.id, v2.version.id, verification.verifiedPaths
  );
  assert.ok(after.changes.some((c) => c.kind === 'renamed-alias-verified'));
  assert.ok(!after.changes.some((c) => c.kind === 'renamed-alias-unverified'));
});

test('样本校验定位嵌套错误并通过注册表返回', async () => {
  const { reg, ds } = await freshRegistry();
  const v = await reg.importDefinition({
    datasetId: ds.id, version: '1.0.0', fileName: 'order.v1.json', text: await loadText('order.v1.json')
  });
  const badSample = JSON.stringify({
    orderId: 'o1',
    amount: 10,
    status: 'CREATED',
    items: [{ sku: 's1', qty: 2 }, { sku: 's2', qty: 'oops' }]
  });
  const r = reg.validateSample(ds.id, v.version.id, badSample);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === 'items.[1].qty'));
});

test('报告导出包含三方向结论，Markdown 可读且未评估版本单独成报告', async () => {
  const { reg, ds } = await freshRegistry();
  const v1 = await reg.importDefinition({
    datasetId: ds.id, version: '1.0.0', fileName: 'order.v1.json', text: await loadText('order.v1.json')
  });
  const v2 = await reg.importDefinition({
    datasetId: ds.id, version: '1.1.0', fileName: 'order.v2.json', text: await loadText('order.v2.json')
  });
  const cmp = reg.compareVersions(ds.id, v1.version.id, v2.version.id);
  const dataset = reg.getDataset(ds.id);
  const report = buildReport({ dataset, comparison: cmp });
  const json = reportToJson(report);
  assert.doesNotThrow(() => JSON.parse(json));
  const md = reportToMarkdown(report);
  assert.match(md, /旧生产者写新结构/);
  assert.match(md, /新生产者写旧结构/);
  assert.match(md, /消费者读取/);
  assert.match(md, /枚举/);

  const bad = await reg.importDefinition({
    datasetId: ds.id, version: '9.9.9', fileName: 'x.txt', text: '{ not json'
  });
  const blocked = reg.compareVersions(ds.id, bad.version.id, v1.version.id);
  const report2 = buildReport({ dataset, comparison: blocked });
  const md2 = reportToMarkdown(report2);
  assert.equal(report2.evaluation.status, 'not_evaluated');
  assert.match(md2, /未评估/);
});
