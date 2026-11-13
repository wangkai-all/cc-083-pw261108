// 通用工具：规范化序列化、SHA-256 内容指纹、深度比较
// 浏览器与 Node 均可用（Web Crypto 全局可用，Node >= 19）。

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** 规范化 JSON：键排序、无多余空白。同一逻辑定义产生同一字符串。 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export function unique(arr) {
  return [...new Set(arr)];
}

/** 把路径片段拼成定位字符串：['order','items','sku'] -> 'order.items.sku' */
export function joinPath(parts) {
  return parts.join('.');
}
