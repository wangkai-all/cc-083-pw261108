// 极简 hyperscript：h('div.cls#id', {onClick}, children...)
// 零依赖、无构建，直接在浏览器以 ESM 运行。

export function h(tag, attrs = {}, ...children) {
  let node;
  let selector = tag;
  if (typeof tag === 'function') {
    // 组件函数
    return tag({ ...attrs, children });
  }
  const idMatch = selector.match(/#([\w-]+)/);
  const classMatch = selector.match(/\.[\w-]+/g);
  const tagName = selector.split(/[#.]/)[0] || 'div';
  node = document.createElement(tagName);
  if (idMatch) node.id = idMatch[1];
  if (classMatch) node.className = classMatch.map((c) => c.slice(1)).join(' ');

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = [node.className, String(value)].filter(Boolean).join(' ');
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key === 'value') {
      node.value = value;
    } else if (key === 'checked') {
      node.checked = !!value;
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') {
      try {
        node[key] = value;
      } catch {
        node.setAttribute(key, String(value));
      }
    } else {
      node.setAttribute(key, String(value));
    }
  }

  appendChildren(node, children.flat(Infinity));
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false || child === '') continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(node, ...children) {
  clear(node);
  appendChildren(node, children.flat(Infinity));
}

export function navigate(hash) {
  location.hash = hash;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
