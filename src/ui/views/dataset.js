// 视图二：数据集详情 —— 导入定义、版本时间线、比较入口。

import { h, navigate } from '../dom.js';
import { registry, notify, toast, uiState } from '../state.js';
import { Badge, EmptyState, StatusPill } from '../components.js';
import { IMPORT_FORMAT, VersionConflictError, VERSION_STATUS } from '../../core/registry.js';

export function DatasetView({ datasetId }) {
  const dataset = registry.getDataset(datasetId);
  if (!dataset) return EmptyState('数据集不存在或已被删除');

  return h('div.view', {},
    breadcrumb(dataset),
    h('div.view-head', {},
      h('div', {},
        h('h2', {}, dataset.name),
        h('p.view-sub', {}, dataset.description || '暂无说明'),
        dataset.owner ? h('p.view-sub', {}, `负责人：${dataset.owner}`) : null
      )
    ),
    ImportPanel(dataset),
    VersionTimeline(dataset),
    ComparePanel(dataset)
  );
}

function breadcrumb(dataset) {
  return h('div.breadcrumb', {},
    h('a', { href: '#/', onClick: (e) => { e.preventDefault(); navigate('/'); } }, '数据集列表'),
    h('span', {}, ' / '),
    h('span', {}, dataset.name)
  );
}

function ImportPanel(dataset) {
  const formatSelect = h('select#imp-format', {},
    h('option', { value: IMPORT_FORMAT.AUTO }, '自动识别格式'),
    h('option', { value: IMPORT_FORMAT.JSON_SCHEMA }, 'JSON Schema'),
    h('option', { value: IMPORT_FORMAT.AVRO }, 'Avro Schema')
  );
  const fileInput = h('input#imp-file', { type: 'file', accept: '.json,.avsc,.txt', style: 'display:none' });
  const textArea = h('textarea#imp-text', { rows: 8, placeholder: '粘贴 JSON Schema / Avro 定义，或选择文件…' });
  const fileName = h('span.file-name', {}, '未选择文件');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileName.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => { textArea.value = reader.result; };
    reader.readAsText(file);
  });

  return h('div.card', {},
    h('h3', {}, '导入契约定义'),
    h('div.form-row', {},
      h('label.field', {}, h('span', {}, '版本号'), h('input#imp-version', { placeholder: '例如 1.0.0 / 2026-11-rc1' })),
      h('label.field.field-narrow', {}, h('span', {}, '格式'), formatSelect)
    ),
    h('div.form-row', {},
      h('label.field', {}, h('span', {}, '定义文件 / 文本'),
        h('div.file-row', {},
          h('button.btn.btn-ghost', {
            onClick: () => fileInput.click()
          }, '选择文件'),
          fileName
        ),
        textArea,
        fileInput
      )
    ),
    h('div.import-actions', {},
      h('button.btn.btn-primary', {
        onClick: async () => {
          const version = document.getElementById('imp-version').value.trim();
          const text = textArea.value;
          if (!version) return toast('请填写版本号', 'error');
          if (!text.trim()) return toast('请提供定义内容或选择文件', 'error');
          try {
            const result = await registry.importDefinition({
              datasetId: dataset.id,
              version,
              fileName: fileName.textContent !== '未选择文件' ? fileName.textContent : 'pasted.json',
              text,
              format: formatSelect.value
            });
            if (result.status === 'duplicated') {
              toast(`版本 ${version} 内容完全相同，已存在（幂等跳过）`, 'info');
            } else if (result.status === 'unevaluated') {
              toast(`版本 ${version} 解析失败，已保留并标记为未评估`, 'error');
            } else {
              toast(`版本 ${version} 导入成功（草稿）`);
              textArea.value = '';
              fileInput.value = '';
              fileName.textContent = '未选择文件';
              document.getElementById('imp-version').value = '';
            }
            notify();
          } catch (e) {
            if (e instanceof VersionConflictError) {
              toast(e.message, 'error');
            } else {
              toast(`导入失败：${e.message}`, 'error');
            }
          }
        }
      }, '导入版本')
    ),
    h('p.form-hint', {}, '规则：同版本号内容不同会拒绝覆盖；解析失败的定义保留原文件并标记“未评估”，不参与兼容性结论。')
  );
}

function VersionTimeline(dataset) {
  if (!dataset.versions.length) {
    return h('div.card', {}, h('h3', {}, '版本历史'), EmptyState('尚未导入任何版本'));
  }
  return h('div.card', {},
    h('h3', {}, `版本历史（${dataset.versions.length}）`),
    h('div.timeline', {}, ...dataset.versions.map((v) => VersionRow(dataset, v)))
  );
}

function VersionRow(dataset, v) {
  const isUnevaluated = v.status === VERSION_STATUS.UNEVALUATED;
  return h('div.timeline-row', {},
    h('div.timeline-main', {
      onClick: () => navigate(`/dataset/${dataset.id}/version/${v.id}`)
    },
      h('div.timeline-version', {},
        h('span.version-code', {}, v.version),
        StatusPill(v.status),
        h('span.format-tag', {}, v.format)
      ),
      h('div.timeline-meta', {},
        `${v.fileName} · ${new Date(v.createdAt).toLocaleString()}`,
        h('span.hash', {}, `内容指纹 ${v.contentHash.slice(0, 12)}…`)
      ),
      isUnevaluated
        ? h('div.parse-error-line', {}, `解析失败：${v.parseError?.message ?? '未知错误'}${v.parseError?.location ? `（${v.parseError.location}）` : ''}`)
        : null
    ),
    h('div.timeline-actions', {},
      isUnevaluated
        ? h('span.warn-text', {}, '未评估，不可发布/比较')
        : h('button.btn.btn-small', {
          onClick: () => {
            registry.publishVersion(dataset.id, v.id);
            toast(`版本 ${v.version} 已发布，进入可比较的历史契约`);
            notify();
          },
          disabled: v.status === VERSION_STATUS.PUBLISHED
        }, v.status === VERSION_STATUS.PUBLISHED ? '已发布' : '发布')
    )
  );
}

function ComparePanel(dataset) {
  const evaluable = dataset.versions.filter((v) => v.status !== VERSION_STATUS.UNEVALUATED && v.ir);
  if (evaluable.length < 2) {
    return h('div.card', {}, h('h3', {}, '结构比较'),
      EmptyState('至少需要两个已解析版本才能比较', '未评估版本不出现在选择器中'));
  }
  const sel = uiState.compareSelection[dataset.id] || {};
  const oldSel = h('select', {},
    h('option', { value: '' }, '选择旧版本…'),
    ...evaluable.map((v) => h('option', { value: v.id, selected: sel.oldId === v.id }, `${v.version}（${v.status}）`))
  );
  const newSel = h('select', {},
    h('option', { value: '' }, '选择新版本…'),
    ...evaluable.map((v) => h('option', { value: v.id, selected: sel.newId === v.id }, `${v.version}（${v.status}）`))
  );
  for (const s of [oldSel, newSel]) {
    s.addEventListener('change', () => {
      uiState.compareSelection[dataset.id] = {
        oldId: oldSel.value || sel.oldId,
        newId: newSel.value || sel.newId
      };
    });
  }
  return h('div.card', {},
    h('h3', {}, '结构比较与兼容评估'),
    h('div.compare-picker', {},
      h('label.field', {}, h('span', {}, '旧版本（基线）'), oldSel),
      h('div.arrow', {}, '→'),
      h('label.field', {}, h('span', {}, '新版本'), newSel),
      h('button.btn.btn-primary', {
        onClick: () => {
          const oldId = oldSel.value;
          const newId = newSel.value;
          if (!oldId || !newId) return toast('请先选择两个版本', 'error');
          if (oldId === newId) return toast('请选择不同的两个版本', 'error');
          uiState.compareSelection[dataset.id] = { oldId, newId };
          navigate(`/dataset/${dataset.id}/compare?old=${oldId}&new=${newId}`);
        }
      }, '开始比较')
    )
  );
}
