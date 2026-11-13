// 视图一：数据集登记列表 + 新建数据集。

import { h, navigate } from '../dom.js';
import { registry, notify, toast } from '../state.js';
import { EmptyState, StatusPill } from '../components.js';
import { VERSION_STATUS } from '../../core/registry.js';

export function DatasetsView() {
  const datasets = registry.listDatasets();

  const createBox = h('div.card.create-card', {},
    h('h3', {}, '登记新数据集'),
    h('div.form-row', {},
      labelInput('名称', 'ds-name', '例如：订单事件 OrderEvent'),
      labelInput('负责人', 'ds-owner', '团队或个人')
    ),
    h('div.form-row', {},
      h('label.field', {}, h('span', {}, '说明'),
        h('textarea#ds-desc', { rows: 2, placeholder: '数据集用途、生产者/消费者背景（可选）' }))
    ),
    h('button.btn.btn-primary', {
      onClick: () => {
        const name = document.getElementById('ds-name').value.trim();
        if (!name) return toast('数据集名称不能为空', 'error');
        const ds = registry.createDataset({
          name,
          owner: document.getElementById('ds-owner').value.trim(),
          description: document.getElementById('ds-desc').value.trim()
        });
        notify();
        toast(`数据集「${ds.name}」已登记`);
        navigate(`/dataset/${ds.id}`);
      }
    }, '登记数据集')
  );

  return h('div.view', {},
    h('div.view-head', {},
      h('div', {},
        h('h2', {}, '数据契约登记'),
        h('p.view-sub', {}, '导入 JSON Schema 或 Avro 定义，按数据集维护版本，并评估结构变化对生产者与消费者的兼容影响。')
      )
    ),
    createBox,
    h('h3.section-title', {}, `已登记数据集（${datasets.length}）`),
    datasets.length === 0
      ? EmptyState('还没有数据集', '先在上方登记一个数据集，再导入契约定义')
      : h('div.dataset-grid', {}, ...datasets.map(DatasetCard))
  );
}

function DatasetCard(ds) {
  const published = ds.versions.filter((v) => v.status === VERSION_STATUS.PUBLISHED).length;
  const unevaluated = ds.versions.filter((v) => v.status === VERSION_STATUS.UNEVALUATED).length;
  const latest = ds.versions[ds.versions.length - 1];
  return h('div.card.dataset-card', {
    onClick: () => navigate(`/dataset/${ds.id}`)
  },
    h('div.dataset-card-head', {},
      h('div.dataset-name', {}, ds.name),
      latest ? StatusPill(latest.status) : h('span.pill pill-draft', {}, '空')
    ),
    ds.owner ? h('div.dataset-meta', {}, `负责人：${ds.owner}`) : null,
    ds.description ? h('p.dataset-desc', {}, ds.description) : null,
    h('div.dataset-stats', {},
      h('span', {}, `版本 ${ds.versions.length}`),
      h('span', {}, `已发布 ${published}`),
      unevaluated ? h('span.warn-text', {}, `未评估 ${unevaluated}`) : null
    ),
    h('div.dataset-meta', {}, latest ? `最近版本：${latest.version}（${latest.format}）` : '尚未导入定义')
  );
}

function labelInput(label, id, placeholder) {
  return h('label.field', {},
    h('span', {}, label),
    h(`input#${id}`, { placeholder })
  );
}
