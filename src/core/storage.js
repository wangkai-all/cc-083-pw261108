// 存储适配：浏览器 localStorage（持久化）与内存 Map（测试用）。

const STORAGE_KEY = 'data-contract-registry:v1';

export class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  load() {
    const raw = this.map.get(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }
  save(state) {
    this.map.set(STORAGE_KEY, JSON.stringify(state));
  }
  clear() {
    this.map.clear();
  }
}

export class LocalStorageStorage {
  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // 存储损坏不应让应用崩溃：隔离到备份键后返回空状态
      localStorage.setItem(`${STORAGE_KEY}:corrupt-${Date.now()}`, raw);
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }
  save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  clear() {
    localStorage.removeItem(STORAGE_KEY);
  }
}
