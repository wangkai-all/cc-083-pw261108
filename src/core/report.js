// 报告导出：结构化 JSON 与 Markdown 两种格式。
// 报告记录的是语义级变更与三方向兼容结论，不是文本差异。

import { VERDICT } from './schemaCompare.js';

const VERDICT_LABEL = {
  [VERDICT.PASS]: '通过',
  [VERDICT.CONDITIONAL]: '有条件通过',
  [VERDICT.FAIL]: '不通过',
  [VERDICT.NOT_EVALUATED]: '未评估'
};

const KIND_LABEL = {
  'added-optional': '新增可选字段',
  'added-required-with-default': '新增必填字段（带默认值）',
  'added-required': '新增必填字段（无默认值）',
  'removed-required': '删除必填字段',
  'removed-optional': '删除可选字段',
  'type-widened': '类型放宽',
  'type-narrowed': '类型收窄',
  'type-changed': '类型族变化',
  'enum-symbol-added': '枚举新增取值',
  'enum-symbol-removed': '枚举删除取值',
  'required-to-optional': '必填改为可选',
  'optional-to-required': '可选改为必填',
  'nullable-to-non': '可空改为非空',
  'non-to-nullable': '非空改为可空',
  'default-changed': '默认值变更',
  'renamed-alias-verified': '字段改名（别名已验证）',
  'renamed-alias-unverified': '字段改名（别名未验证）',
  'renamed-no-alias': '字段改名（无别名）'
};

export function buildReport({ dataset, comparison, generatedAt = new Date().toISOString() }) {
  return {
    reportType: 'data-contract-compatibility',
    generatedAt,
    dataset: {
      id: dataset.id,
      name: dataset.name,
      owner: dataset.owner || '',
      description: dataset.description || ''
    },
    versions: comparison.notEvaluated
      ? null
      : {
          old: comparison.oldVersion,
          new: comparison.newVersion
        },
    evaluation: comparison.notEvaluated
      ? { status: 'not_evaluated', reason: comparison.reason }
      : {
          status: comparison.summary.overall,
          fullyCompatible: comparison.summary.fullyCompatible,
          directions: {
            backward: comparison.summary.backward,
            forward: comparison.summary.forward,
            consumer: comparison.summary.consumer
          },
          changeCount: comparison.changeCount
        },
    changes: comparison.notEvaluated
      ? []
      : comparison.changes.map((c) => ({
          kind: c.kind,
          kindLabel: KIND_LABEL[c.kind] || c.kind,
          path: c.path,
          detail: c.detail,
          directions: c.directions
        }))
  };
}

export function reportToJson(report) {
  return JSON.stringify(report, null, 2);
}

export function reportToMarkdown(report) {
  const lines = [];
  lines.push(`# 数据契约兼容性报告 — ${report.dataset.name}`);
  lines.push('');
  lines.push(`- 生成时间: ${report.generatedAt}`);
  if (report.dataset.owner) lines.push(`- 负责人: ${report.dataset.owner}`);
  if (report.dataset.description) lines.push(`- 说明: ${report.dataset.description}`);

  if (report.evaluation.status === 'not_evaluated') {
    lines.push('');
    lines.push('## 结论：未评估');
    lines.push('');
    lines.push(`> ${report.evaluation.reason}`);
    lines.push('');
    lines.push('未解析的定义不参与任何通过结论，请修复定义后重新导入。');
    return lines.join('\n');
  }

  const { old: o, new: n } = report.versions;
  lines.push(`- 比较版本: **${o.version}** (${o.format}, ${o.contentHash.slice(0, 12)}…)`);
  lines.push(`  → **${n.version}** (${n.format}, ${n.contentHash.slice(0, 12)}…)`);
  lines.push('');
  lines.push('## 兼容结论');
  lines.push('');
  lines.push('| 检查方向 | 结论 |');
  lines.push('| --- | --- |');
  lines.push(`| 旧生产者写新结构（向后兼容） | ${VERDICT_LABEL[report.evaluation.directions.backward]} |`);
  lines.push(`| 新生产者写旧结构（向前兼容） | ${VERDICT_LABEL[report.evaluation.directions.forward]} |`);
  lines.push(`| 消费者读取 | ${VERDICT_LABEL[report.evaluation.directions.consumer]} |`);
  lines.push('');
  lines.push(`总体结论: **${VERDICT_LABEL[report.evaluation.status]}**（共 ${report.evaluation.changeCount} 项结构化变更）`);
  lines.push('');
  lines.push('## 变更明细（按字段路径）');
  lines.push('');
  if (!report.changes.length) {
    lines.push('无结构差异，两版本契约等价。');
  }
  for (const c of report.changes) {
    lines.push(`### ${c.kindLabel} — \`${c.path || '$'}\``);
    if (c.detail) lines.push(`- 详情: ${c.detail}`);
    lines.push(`- 旧生产者写新结构: **${VERDICT_LABEL[c.directions.backward.verdict]}** — ${c.directions.backward.reason}`);
    lines.push(`- 新生产者写旧结构: **${VERDICT_LABEL[c.directions.forward.verdict]}** — ${c.directions.forward.reason}`);
    lines.push(`- 消费者读取: **${VERDICT_LABEL[c.directions.consumer.verdict]}** — ${c.directions.consumer.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
