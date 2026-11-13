// 视图三：版本详情 —— 契约结构树、样本校验、原始定义、解析失败留存。

import { h, navigate } from '../dom.js';
import { registry, notify, toast, uiState } from '../state.js';
import { EmptyState, FieldFlags, StatusPill, Badge } from '../components.js';
import { VERSION_STATUS } from '../../core/registry.js';
import { downloadText } from '../../core/report.js';

export function VersionView({ datasetId, versionId }) {
  const dataset = registry.getDataset(datasetId);
  const version = dataset?.versions.find((v) => v.id === versionId);
  if (!dataset || !version) return EmptyState('版本不存在');

  return h('div.view', {},
    h('div.breadcrumb', {},
      h('a', { href: `#/dataset/${datasetId}`, onClick: (e) => { e.preventDefault(); navigate(`/dataset/${datasetId}`); } }, dataset.name),
      h('span', {}, ' / '),
      h('span', {}, `版本 ${version.version}`)
    ),
    h('div.view-head', {},
      h('div', {},
        h('h2', {}, `版本 ${version.version} `, StatusPill(version.status)),
        h('p.view-sub', {}, `${version.fileName} · ${version.format} · 指纹 ${version.contentHash.slice(0, 16)}…`)
      ),
      h('div.view-actions', {},
        h('button.btn.btn-ghost', {
          onClick: () => downloadText(
            `${dataset.name}-${version.version}-definition.json`,
            version.status === VERSION_STATUS.UNEVALUATED ? version.rawText : JSON.stringify(version.rawDefinition, null, 2),
            'application/json'
          )
        }, '导出原始定义')
      )
    ),
    version.status === VERSION_STATUS.UNEVALUATED
      ? UnevaluatedPanel(version)
      : [StructurePanel(version), SamplePanel(dataset, version)]
  );
}

function UnevaluatedPanel(version) {
  return h('div', {},
    h('div.card.error-card', {},
      h('h3', {}, '定义未评估'),
      h('p', {}, '该定义解析失败，原始文件已保留。未解析的定义不参与任何兼容性通过结论，也不能发布。'),
      h('div.error-detail', {},
        h('div', {}, `阶段：${version.parseError.stage === 'json-parse' ? 'JSON 语法' : 'Schema 结构解析'}`),
        h('div', {}, `错误：${version.parseError.message}`),
        version.parseError.location ? h('div', {}, `定位：${version.parseError.location}`) : null
      )
    ),
    h('div.card', {},
      h('h3', {}, '保留的原始文件内容'),
      h('pre.code-block', {}, version.rawText)
    )
  );
}

function StructurePanel(version) {
  return h('div.card', {},
    h('h3', {}, '契约结构（统一 IR 视图）'),
    h('p.form-hint', {}, '“可选 / 可空 / 默认值”为三个相互独立的概念，分别以独立标记展示。'),
    h('div.schema-tree', {}, TypeTree(version.ir.root, 0, true))
  );
}

function TypeTree(node, depth, isRoot) {
  const pad = { style: `padding-left:${depth * 18}px` };
  if (node.kind === 'record') {
    return h('div', {},
      h('div.tree-node', pad, h('span.type-label', {}, isRoot ? 'record（根）' : `record${node.recordName ? ` ${node.recordName}` : ''}`)),
      ...node.fields.map((f) => h('div', {},
        h('div.tree-node', { style: `padding-left:${(depth + 1) * 18}px` },
          h('span.field-name', {}, f.name),
          FieldFlags(f),
          f.aliases?.length ? h('span.chip chip-alias', {}, `别名: ${f.aliases.join(', ')}`) : null,
          f.description ? h('span.field-doc', {}, f.description) : null
        ),
        TypeTree(f.type, depth + 2, false)
      ))
    );
  }
  if (node.kind === 'array') {
    return h('div', {},
      h('div.tree-node', pad, h('span.type-label', {}, 'array[]')),
      TypeTree(node.items, depth + 1, false)
    );
  }
  if (node.kind === 'map') {
    return h('div', {},
      h('div.tree-node', pad, h('span.type-label', {}, 'map{}')),
      TypeTree(node.values, depth + 1, false)
    );
  }
  if (node.kind === 'union') {
    return h('div', {},
      h('div.tree-node', pad, h('span.type-label', {}, `union${node.nullable ? '（可空）' : ''}`)),
      ...node.types.map((t) => TypeTree(t, depth + 1, false))
    );
  }
  if (node.kind === 'enum') {
    return h('div.tree-node', pad,
      h('span.type-label', {}, `enum${node.enumName ? ` ${node.enumName}` : ''}`),
      h('span.enum-symbols', {}, node.symbols.join(' | '))
    );
  }
  const label = node.kind === 'primitive'
    ? node.name + (node.nullable ? '?' : '') + (node.logicalType ? ` (${node.logicalType})` : '')
    : node.kind === 'fixed' ? `fixed(${node.size})` : node.kind;
  return h('div.tree-node', pad, h('span.type-label', {}, label));
}

function SamplePanel(dataset, version) {
  const resultBox = h('div#sample-result');
  const textarea = h('textarea#sample-text', {
    rows: 7,
    placeholder: '粘贴一条样例数据（JSON），坏样例会定位到具体的嵌套字段路径…'
  });
  if (uiState.samples[version.id]) textarea.value = uiState.samples[version.id];

  function run() {
    const text = textarea.value;
    uiState.samples[version.id] = text;
    if (!text.trim()) {
      toast('请先粘贴样例数据', 'error');
      return;
    }
    const result = registry.validateSample(dataset.id, version.id, text);
    resultBox.innerHTML = '';
    if (result.sampleParseError) {
      resultBox.appendChild(h('div.card.error-card', {}, h('strong', {}, result.sampleParseError)));
      return;
    }
    if (result.valid) {
      resultBox.appendChild(h('div.card.ok-card', {},
        h('div.result-head', {}, Badge('pass'), h('span', {}, '样例符合当前契约'))
      ));
    } else {
      resultBox.appendChild(h('div.card.error-card', {},
        h('div.result-head', {}, Badge('fail'), h('span', {}, `发现 ${result.errors.length} 个字段错误`)),
        h('ul.error-list', {}, ...result.errors.map((e) =>
          h('li', {},
            h('code.error-path', {}, e.path),
            h('span.error-message', {}, e.message)
          )
        ))
      ));
    }
  }

  return h('div.card', {},
    h('h3', {}, '样例数据校验'),
    textarea,
    h('div.import-actions', {},
      h('button.btn.btn-primary', { onClick: run }, '校验样例'),
      h('button.btn.btn-ghost', {
        onClick: () => {
          const sample = buildSkeleton(version.ir.root);
          textarea.value = JSON.stringify(sample, null, 2);
          uiState.samples[version.id] = textarea.value;
          notify();
        }
      }, '生成样例骨架')
    ),
    resultBox
  );
}

function buildSkeleton(node) {
  if (node.kind === 'record') {
    const out = {};
    for (const f of node.fields) {
      if (f.hasDefault) continue;
      out[f.name] = f.type.nullable ? null : buildSkeleton(f.type);
    }
    return out;
  }
  if (node.kind === 'array') return [buildSkeleton(node.items)];
  if (node.kind === 'map') return { key: buildSkeleton(node.values) };
  if (node.kind === 'enum') return node.symbols[0];
  if (node.kind === 'union') return buildSkeleton(node.types[0]);
  if (node.kind === 'primitive') {
    return { string: 'string', boolean: true, int: 0, long: 0, float: 0, double: 0, bytes: '', null: null }[node.name] ?? null;
  }
  if (node.kind === 'fixed') return '';
  return null;
}
