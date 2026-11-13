// 应用状态：注册表实例 + hash 路由 + 轻量订阅。

import { ContractRegistry } from '../core/registry.js';
import { LocalStorageStorage } from '../core/storage.js';

export const registry = new ContractRegistry(new LocalStorageStorage());

// 会话级 UI 状态（不持久化）：当前比较选择、样本内容等
export const uiState = {
  compareSelection: {}, // datasetId -> { oldId, newId }
  samples: {}, // versionId -> 文本
  oldSamples: {}, // `${oldId}:${newId}` -> 文本
  toast: null
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) fn();
}

export function toast(message, type = 'info') {
  uiState.toast = { message, type, at: Date.now() };
  notify();
  setTimeout(() => {
    if (uiState.toast && Date.now() - uiState.toast.at >= 2400) {
      uiState.toast = null;
      notify();
    }
  }, 2500);
}

export function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(query));
  return { parts, params };
}

export function route() {
  const { parts, params } = parseRoute();
  if (!parts.length) return { name: 'datasets' };
  if (parts[0] === 'dataset' && parts[1]) {
    if (parts[2] === 'version' && parts[3]) {
      return { name: 'version', datasetId: parts[1], versionId: parts[3] };
    }
    if (parts[2] === 'compare') return { name: 'compare', datasetId: parts[1], params };
    return { name: 'dataset', datasetId: parts[1] };
  }
  return { name: 'datasets' };
}
