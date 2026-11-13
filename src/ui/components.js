// 共享展示组件：结论徽章、三方向卡片、变更类型标签、空态。

import { h } from './dom.js';
import { VERDICT } from '../core/schemaCompare.js';

export const VERDICT_META = {
  [VERDICT.PASS]: { label: '通过', cls: 'pass', icon: '✓' },
  [VERDICT.CONDITIONAL]: { label: '有条件通过', cls: 'conditional', icon: '!' },
  [VERDICT.FAIL]: { label: '不通过', cls: 'fail', icon: '✕' },
  [VERDICT.NOT_EVALUATED]: { label: '未评估', cls: 'unknown', icon: '?' }
};

export const KIND_META = {
  'added-optional': { label: '新增可选字段', tone: 'ok' },
  'added-required-with-default': { label: '新增必填字段（带默认值）', tone: 'warn' },
  'added-required': { label: '新增必填字段（无默认值）', tone: 'danger' },
  'removed-required': { label: '删除必填字段', tone: 'danger' },
  'removed-optional': { label: '删除可选字段', tone: 'warn' },
  'type-widened': { label: '类型放宽', tone: 'warn' },
  'type-narrowed': { label: '类型收窄', tone: 'danger' },
  'type-changed': { label: '类型族变化', tone: 'danger' },
  'enum-symbol-added': { label: '枚举新增取值', tone: 'warn' },
  'enum-symbol-removed': { label: '枚举删除取值', tone: 'danger' },
  'required-to-optional': { label: '必填 → 可选', tone: 'ok' },
  'optional-to-required': { label: '可选 → 必填', tone: 'warn' },
  'nullable-to-non': { label: '可空 → 非空', tone: 'danger' },
  'non-to-nullable': { label: '非空 → 可空', tone: 'warn' },
  'default-changed': { label: '默认值变更', tone: 'warn' },
  'renamed-alias-verified': { label: '改名·别名已验证', tone: 'ok' },
  'renamed-alias-unverified': { label: '改名·别名未验证', tone: 'danger' },
  'renamed-no-alias': { label: '改名·无别名', tone: 'danger' }
};

export function Badge(verdict) {
  const meta = VERDICT_META[verdict] || VERDICT_META[VERDICT.NOT_EVALUATED];
  return h(`span.badge.badge-${meta.cls}`, {}, `${meta.icon} ${meta.label}`);
}

export function KindTag(kind) {
  const meta = KIND_META[kind] || { label: kind, tone: 'warn' };
  return h(`span.kind-tag.kind-${meta.tone}`, {}, meta.label);
}

const DIRECTION_TITLES = {
  backward: { title: '旧生产者写新结构', hint: '旧版本数据被新版本结构读取（向后兼容）' },
  forward: { title: '新生产者写旧结构', hint: '新版本数据被旧版本结构读取（向前兼容）' },
  consumer: { title: '消费者读取', hint: '消费侧在两方向上的综合风险' }
};

export function DirectionCard(direction, entry) {
  const meta = VERDICT_META[entry.verdict] || VERDICT_META[VERDICT.NOT_EVALUATED];
  const d = DIRECTION_TITLES[direction];
  return h(`div.direction-card.direction-${meta.cls}`, {},
    h('div.direction-head', {},
      h('div.direction-title', {}, d.title),
      Badge(entry.verdict)
    ),
    h('div.direction-hint', {}, d.hint),
    h('p.direction-reason', {}, entry.reason)
  );
}

export function SummaryBar(summary) {
  return h('div.summary-bar', {},
    h('div.summary-item', {}, h('div.summary-label', {}, '旧生产者写新结构'), Badge(summary.backward)),
    h('div.summary-item', {}, h('div.summary-label', {}, '新生产者写旧结构'), Badge(summary.forward)),
    h('div.summary-item', {}, h('div.summary-label', {}, '消费者读取'), Badge(summary.consumer)),
    h('div.summary-item', {}, h('div.summary-label', {}, '总体结论'), Badge(summary.overall))
  );
}

export function EmptyState(text, sub = '') {
  return h('div.empty-state', {},
    h('div.empty-icon', {}, '◌'),
    h('div.empty-text', {}, text),
    sub ? h('div.empty-sub', {}, sub) : null
  );
}

export function StatusPill(status) {
  const map = {
    draft: ['草稿', 'pill-draft'],
    published: ['已发布', 'pill-published'],
    unevaluated: ['未评估', 'pill-unknown']
  };
  const [label, cls] = map[status] || [status, 'pill-draft'];
  return h(`span.pill ${cls}`, {}, label);
}

export function FieldFlags(field) {
  const chips = [];
  chips.push(h(`span.chip ${field.required ? 'chip-required' : 'chip-optional'}`, {},
    field.required ? '必填' : '可选'));
  if (field.type?.nullable || field.nullable) chips.push(h('span.chip chip-nullable', {}, '可空'));
  if (field.hasDefault) {
    chips.push(h('span.chip chip-default', { title: `默认值: ${JSON.stringify(field.default)}` },
      `默认 ${formatDefault(field.default)}`));
  }
  return h('span.flag-row', {}, ...chips);
}

function formatDefault(v) {
  const s = JSON.stringify(v);
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}
