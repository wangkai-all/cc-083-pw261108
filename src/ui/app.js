// 应用入口：路由分发与全局渲染。

import { h, mount } from './dom.js';
import { route, subscribe, uiState } from './state.js';
import { DatasetsView } from './views/datasets.js';
import { DatasetView } from './views/dataset.js';
import { VersionView } from './views/version.js';
import { CompareView } from './views/compare.js';

const app = document.getElementById('app');
const toastHost = document.getElementById('toast-host');

function render() {
  const r = route();
  let view;
  switch (r.name) {
    case 'dataset':
      view = DatasetView({ datasetId: r.datasetId });
      break;
    case 'version':
      view = VersionView({ datasetId: r.datasetId, versionId: r.versionId });
      break;
    case 'compare':
      view = CompareView({ datasetId: r.datasetId, params: r.params });
      break;
    default:
      view = DatasetsView();
  }
  mount(app, view);
  renderToast();
}

function renderToast() {
  mount(toastHost);
  if (!uiState.toast) return;
  const t = uiState.toast;
  mount(toastHost, h(`div.toast toast-${t.type}`, {}, t.message));
}

window.addEventListener('hashchange', render);
subscribe(render);
render();
