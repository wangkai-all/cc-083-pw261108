// 视图四：版本比较 —— 三方向兼容结论、结构化变更清单、改名别名旧数据验证、报告导出。

import { h, navigate } from '../dom.js';
import { registry, notify, toast, uiState } from '../state.js';
import { Badge, DirectionCard, EmptyState, KindTag, SummaryBar } from '../components.js';
import { buildReport, reportToJson, reportToMarkdown, downloadText } from '../../core/report.js';

export function CompareView({ datasetId, params }) {
  const dataset = registry.getDataset(datasetId);
  if (!dataset) return EmptyState('数据集不存在');
  const oldId = params.old;
  const newId = params.new;
  if (!oldId || !newId) return EmptyState('缺少比较版本参数');

  const oldV = dataset.versions.find((v) => v.id === oldId);
  const newV = dataset.versions.find((v) => v.id === newId);
  if (!oldV || !newV) return EmptyState('版本不存在');

  // 先做一次基础比较（未验证别名保持 unverified）
  const base = registry.compareVersions(datasetId, oldId, newId);

  return h('div.view', {},
    h('div.breadcrumb', {},
      h('a', { href: `#/dataset/${datasetId}`, onClick: (e) => { e.preventDefault(); navigate(`/dataset/${datasetId}`); } }, dataset.name),
      h('span', {}, ' / 结构比较')
    ),
    h('div.view-head', {},
      h('div', {},
        h('h2', {}, `兼容评估：${oldV.version} → ${newV.version}`),
        h('p.view-sub', {}, `${oldV.format} → ${newV.format} · 指纹 ${oldV.contentHash.slice(0, 10)}… / ${newV.contentHash.slice(0, 10)}…`)
      )
    ),
    base.notEvaluated ? NotEvaluatedPanel(base) : EvaluatedPanel(dataset, oldV, newV, base)
  );
}

function NotEvaluatedPanel(base) {
  return h('div.card.error-card', {},
    h('h3', {}, '无法给出兼容结论：未评估'),
    h('p', {}, base.reason),
    h('p', {}, '请修复对应定义后以新版本重新导入；未解析的定义永远不会参与“通过”结论。')
  );
}

function EvaluatedPanel(dataset, oldV, newV, base) {
  const sampleKey = `${oldV.id}:${newV.id}`;

  // 改名验证状态（会话内）
  const verifyBox = h('div#rename-verify');
  const changesBox = h('div#changes-box');
  const summaryBox = h('div#summary-box');

  let verifiedPaths = uiState.verifiedRenames?.[sampleKey] || [];

  function renderComparison() {
    const comparison = registry.compareVersions(dataset.id, oldV.id, newV.id, verifiedPaths);
    summaryBox.innerHTML = '';
    summaryBox.appendChild(h('div', {},
      SummaryBar(comparison.summary),
      h('p.form-hint', {},
        comparison.summary.fullyCompatible
          ? '三个方向均为通过：该演进对存量生产者、消费者无破坏。'
          : '任一方向存在“不通过/有条件通过”时，请逐条查看下方语义说明与处置建议。')
    ));

    changesBox.innerHTML = '';
    if (!comparison.changes.length) {
      changesBox.appendChild(EmptyState('两版本无结构差异，契约等价'));
    } else {
      for (const card of comparison.changes.map(ChangeCard)) changesBox.appendChild(card);
    }

    // 有改名（无论是否验证）才显示旧数据验证面板
    const renameChanges = comparison.changes.filter((c) => c.kind.startsWith('renamed-'));
    verifyBox.innerHTML = '';
    if (renameChanges.length) verifyBox.appendChild(RenamePanel(renameChanges, sampleKey, () => {
      renderComparison();
      notify();
    }, (paths) => { verifiedPaths = paths; }));
    return comparison;
  }

  const comparison = renderComparison();

  return h('div', {},
    summaryBox,
    h('div.card.export-card', {},
      h('h3', {}, '报告导出'),
      h('p.form-hint', {}, '导出内容为语义级变更与三方向结论（非文本差异），含数据集、版本指纹与生成时间。'),
      h('div.import-actions', {},
        h('button.btn.btn-primary', {
          onClick: () => {
            const fresh = registry.compareVersions(dataset.id, oldV.id, newV.id, verifiedPaths);
            const report = buildReport({ dataset, comparison: fresh });
            downloadText(`${dataset.name}-${oldV.version}-to-${newV.version}-report.json`, reportToJson(report), 'application/json');
            toast('JSON 报告已导出');
          }
        }, '导出 JSON 报告'),
        h('button.btn', {
          onClick: () => {
            const fresh = registry.compareVersions(dataset.id, oldV.id, newV.id, verifiedPaths);
            const report = buildReport({ dataset, comparison: fresh });
            downloadText(`${dataset.name}-${oldV.version}-to-${newV.version}-report.md`, reportToMarkdown(report), 'text/markdown');
            toast('Markdown 报告已导出');
          }
        }, '导出 Markdown 报告')
      )
    ),
    verifyBox,
    h('div.card', {},
      h('h3', {}, `结构化变更明细（${comparison.changes.length}）`),
      h('p.form-hint', {}, '每类变更分别说明三个兼容方向的影响与原因，而不是展示文本差异。'),
      changesBox
    )
  );
}

function ChangeCard(change) {
  return h('div.change-card', {},
    h('div.change-head', {},
      KindTag(change.kind),
      h('code.change-path', {}, change.path || '$'),
      change.detail ? h('span.change-detail', {}, change.detail) : null
    ),
    h('div.direction-grid', {},
      DirectionCard('backward', change.directions.backward),
      DirectionCard('forward', change.directions.forward),
      DirectionCard('consumer', change.directions.consumer)
    )
  );
}

function RenamePanel(renameChanges, sampleKey, rerender, setVerified) {
  const textarea = h('textarea#old-sample', {
    rows: 7,
    placeholder: '粘贴一条按【旧版本结构】写出的样例数据（使用旧字段名），验证新结构能否通过别名读取…'
  });
  if (uiState.oldSamples?.[sampleKey]) textarea.value = uiState.oldSamples[sampleKey];

  const resultBox = h('div');
  const allVerified = renameChanges.every((c) => c.kind === 'renamed-alias-verified');
  if (allVerified) {
    resultBox.appendChild(h('div.card.ok-card', {},
      h('div.result-head', {}, Badge('pass'), h('span', {}, '旧样例已通过新结构校验，改名别名可读性已验证'))
    ));
  }

  return h('div.card.rename-card', {},
    h('h3', {}, '改名别名验证（旧数据可读性）'),
    h('ul.rename-list', {}, ...renameChanges.map((c) =>
      h('li', {},
        h('code', {}, c.path),
        h('span', {}, c.kind === 'renamed-no-alias'
          ? `无别名：${c.oldName} → ${c.newName}，旧数据无法映射`
          : `别名 [${c.detail}]；${c.kind === 'renamed-alias-verified' ? '已验证可读' : '尚未验证，不构成通过证据'}`)
      )
    )),
    textarea,
    h('div.import-actions', {},
      h('button.btn.btn-primary', {
        onClick: () => {
          const text = textarea.value;
          if (!text.trim()) return toast('请粘贴旧版本样例数据', 'error');
          uiState.oldSamples = uiState.oldSamples || {};
          uiState.oldSamples[sampleKey] = text;
          const [oldId, newId] = sampleKey.split(':');
          // datasetId 从闭包外取：通过 DOM 上的 data 属性不优雅，直接从 registry 反查
          const dataset = findDatasetOfVersion(oldId);
          const result = registry.verifyRenameWithOldSample(dataset.id, oldId, newId, text);
          resultBox.innerHTML = '';
          if (result.sampleParseError) {
            resultBox.appendChild(h('div.card.error-card', {}, h('strong', {}, result.sampleParseError)));
            return;
          }
          if (result.valid) {
            uiState.verifiedRenames = uiState.verifiedRenames || {};
            uiState.verifiedRenames[sampleKey] = result.verifiedPaths;
            setVerified(result.verifiedPaths);
            resultBox.appendChild(h('div.card.ok-card', {},
              h('div.result-head', {}, Badge('pass'),
                h('span', {}, `旧数据经别名映射读取成功，已验证路径：${result.verifiedPaths.join('、') || '（无带别名字段）'}`))
            ));
            toast('别名验证通过，兼容结论已更新');
          } else {
            resultBox.appendChild(h('div.card.error-card', {},
              h('div.result-head', {}, Badge('fail'), h('span', {}, `旧数据无法被新结构读取，共 ${result.errors.length} 个错误`)),
              h('ul.error-list', {}, ...result.errors.map((e) =>
                h('li', {}, h('code.error-path', {}, e.path), h('span.error-message', {}, e.message))
              ))
            ));
            toast('别名验证失败，改名保持“不通过/未验证”', 'error');
          }
          rerender();
        }
      }, '用旧样例验证可读性'),
      allVerified ? Badge('pass') : Badge('conditional')
    ),
    resultBox
  );
}

function findDatasetOfVersion(versionId) {
  return registry.listDatasets().find((ds) => ds.versions.some((v) => v.id === versionId));
}
