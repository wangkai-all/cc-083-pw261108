// 结构差异引擎：对比两个 IR，输出按字段路径分类的结构化变更，
// 并分别评估三个方向的兼容性：
//   backward —— 旧生产者写新结构（旧数据能否被新结构读取）
//   forward  —— 新生产者写旧结构（新数据能否被旧结构读取）
//   consumer —— 消费者读取（消费侧两方向综合风险）

import { joinPath } from './util.js';

export const VERDICT = Object.freeze({
  PASS: 'pass',
  CONDITIONAL: 'conditional',
  FAIL: 'fail',
  NOT_EVALUATED: 'not_evaluated'
});

export const VERDICT_RANK = { [VERDICT.PASS]: 0, [VERDICT.CONDITIONAL]: 1, [VERDICT.FAIL]: 2, [VERDICT.NOT_EVALUATED]: 3 };

// 只有数值/字节宽度族有等级；boolean、string 等无宽度，跨族即类型族变化
const WIDTH = { int: 2, long: 2, float: 3, double: 4, bytes: 1, string: 1 };
// 同宽对：JSON Schema integer 归一为 long，因此 int 与 long 互相视为同宽
const SAME_WIDTH = new Set(['int|long', 'long|int']);

function widthOf(name) {
  return WIDTH[name] ?? null;
}

function worse(a, b) {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

function dir(backward, forward, consumer, reasonBackward, reasonForward, reasonConsumer) {
  return {
    backward: { verdict: backward, reason: reasonBackward },
    forward: { verdict: forward, reason: reasonForward },
    consumer: { verdict: consumer, reason: reasonConsumer }
  };
}

// 每类变更的语义级兼容模板（不展示文本差异，展示为什么）
const RULES = {
  'added-optional': () =>
    dir(
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      VERDICT.CONDITIONAL,
      '旧数据没有该字段，新结构视其为可选，读取时缺失合法。',
      '新数据携带该字段，旧结构必须忽略未知字段才能读取（JSON Schema 默认允许；Avro 会跳过未知字段）。',
      '严格校验未知字段的消费者可能拒收新数据；仅消费旧数据则不受影响。'
    ),
  'added-required-with-default': () =>
    dir(
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      VERDICT.CONDITIONAL,
      '旧数据缺失该字段时按默认值填充，读取合法。',
      '新数据携带该字段；旧结构依赖默认值语义或忽略未知字段，取决于读取器实现。',
      '依赖默认值填充的消费者需确认运行时确实应用默认值，而不是把缺失当错误。'
    ),
  'added-required': () =>
    dir(
      VERDICT.FAIL,
      VERDICT.CONDITIONAL,
      VERDICT.FAIL,
      '旧生产者无法产出该必填字段，旧数据被新结构读取时校验失败。',
      '新数据含该字段；仅当旧结构忽略未知字段时可被读取。',
      '仍在读取旧数据的消费者会直接遇到必填校验失败，需要双写或灰度。'
    ),
  'removed-required': () =>
    dir(
      VERDICT.CONDITIONAL,
      VERDICT.FAIL,
      VERDICT.FAIL,
      '旧数据仍携带该字段，新结构必须忽略未知字段才能读取。',
      '新生产者不再产出该必填字段，旧结构读取时必填校验失败。',
      '仍按旧契约读取的消费者会缺失必填字段，必须先完成消费者升级再下线字段。'
    ),
  'removed-optional': () =>
    dir(
      VERDICT.CONDITIONAL,
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      '旧数据可能携带该字段，新结构需要忽略未知字段。',
      '该字段本就可选，新数据缺失对旧结构合法。',
      '读取该可选字段的消费者会遇到空值路径，需确认缺失处理逻辑。'
    ),
  'type-widened': (c) =>
    dir(
      VERDICT.PASS,
      VERDICT.FAIL,
      VERDICT.CONDITIONAL,
      `旧值类型 ${c.oldType} 是新类型 ${c.newType} 的窄类型，新结构可安全读取。`,
      `新值可能是更宽的 ${c.newType}，旧结构按 ${c.oldType} 解析可能溢出或失败。`,
      '只处理旧数据的消费者安全；读取新数据的消费者需要先升级类型处理。'
    ),
  'type-narrowed': (c) =>
    dir(
      VERDICT.FAIL,
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      `旧值可能是更宽的 ${c.oldType}，新结构按窄类型 ${c.newType} 读取可能截断或失败。`,
      `新值类型 ${c.newType} 是旧类型 ${c.oldType} 的窄类型，旧结构可安全读取。`,
      '仍处理旧数据的消费者有截断/反序列化失败风险。'
    ),
  'type-changed': (c) =>
    dir(
      VERDICT.FAIL,
      VERDICT.FAIL,
      VERDICT.FAIL,
      `类型族变化：${c.oldType} -> ${c.newType}，不存在安全的隐式转换。`,
      `类型族变化：${c.oldType} -> ${c.newType}，不存在安全的隐式转换。`,
      '两方向数据都可能反序列化失败，必须通过双写/视图转换迁移。'
    ),
  'enum-symbol-added': (c) =>
    dir(
      VERDICT.PASS,
      VERDICT.FAIL,
      VERDICT.CONDITIONAL,
      '旧枚举值仍是新枚举的子集，新结构可读取全部旧数据。',
      `新数据可能出现旧枚举不认识的符号 ${c.detail}，旧结构读取失败。`,
      '使用穷举 switch/白名单的消费者遇到新符号会落入默认分支或报错。'
    ),
  'enum-symbol-removed': (c) =>
    dir(
      VERDICT.FAIL,
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      `旧数据可能仍包含被删除的符号 ${c.detail}，新结构枚举校验失败。`,
      '新枚举值是旧枚举的子集，旧结构可读取。',
      '历史数据重放/回溯处理会因被删符号失败，需先确认存量数据已清洗。'
    ),
  'required-to-optional': () =>
    dir(
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      VERDICT.CONDITIONAL,
      '必填变可选对旧数据天然满足，读取合法。',
      '新数据可能省略该字段，旧结构若仍标记必填则校验失败。',
      '消费者需要补齐“字段缺失”分支，不能再假设该字段一定存在。'
    ),
  'optional-to-required': (c) =>
    dir(
      VERDICT.CONDITIONAL,
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      '旧数据可能省略该字段，新结构必填校验失败（除非存量数据全部含值）。',
      '新数据必然含该字段，旧结构读取合法。',
      c.hasDefault
        ? '存在默认值：缺失时可填充，风险降低但仍需确认运行时行为。'
        : '无默认值兜底，存量缺失数据会直接失败。'
    ),
  'nullable-to-non': () =>
    dir(
      VERDICT.FAIL,
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      '旧数据可能是 null，新结构非空校验失败。',
      '新数据保证非 null，旧结构读取合法。',
      '含 null 的历史数据重放会失败，需先清洗 null 值。'
    ),
  'non-to-nullable': () =>
    dir(
      VERDICT.PASS,
      VERDICT.FAIL,
      VERDICT.CONDITIONAL,
      '旧数据都非 null，满足新结构的可空要求。',
      '新数据可能是 null，旧结构未声明可空，读取/反序列化可能失败。',
      '消费者需要新增 null 分支处理，否则会出现空指针类问题。'
    ),
  'default-changed': (c) =>
    dir(
      VERDICT.CONDITIONAL,
      VERDICT.CONDITIONAL,
      VERDICT.CONDITIONAL,
      `默认值变化（${c.detail}）：旧数据若依赖该字段缺失时的填充值，语义会改变。`,
      '默认值不影响已写出的字段值，但旧读取器填充的仍是旧默认值。',
      '把默认值当业务含义使用的消费者会出现新旧数据口径不一致。'
    ),
  'renamed-alias-verified': (c) =>
    dir(
      VERDICT.PASS,
      VERDICT.CONDITIONAL,
      VERDICT.CONDITIONAL,
      `字段改名为 ${c.newName}，别名 ${c.detail} 覆盖旧名，旧数据经别名映射仍可读（已用样例验证）。`,
      '旧结构只认识旧名，需要忽略新名或同样配置反向别名。',
      '别名解析依赖读取器实现；未实现别名映射的消费者仍会读成缺失。'
    ),
  'renamed-alias-unverified': (c) =>
    dir(
      VERDICT.CONDITIONAL,
      VERDICT.CONDITIONAL,
      VERDICT.FAIL,
      `字段改名为 ${c.newName} 且声明了别名 ${c.detail}，但未用旧样例数据验证可读性，不能给出通过结论。`,
      '旧结构只认识旧名，需要忽略新名或配置反向别名。',
      '未验证的别名不构成兼容性证据，必须补旧样例验证后才能放行。'
    ),
  'renamed-no-alias': (c) =>
    dir(
      VERDICT.FAIL,
      VERDICT.FAIL,
      VERDICT.FAIL,
      `字段 ${c.oldName} 改名为 ${c.newName} 且无别名，旧数据中的旧名字段在新结构中变成未知字段，数据丢失。`,
      '新数据只含新名，旧结构按旧名读取得到缺失，必填时直接失败。',
      '改名未配别名等于删除旧字段+新增字段，消费者两侧都会受影响。'
    )
};

function makeChange(kind, path, detail, extra = {}) {
  const template = RULES[kind];
  if (!template) throw new Error(`未知变更类型: ${kind}`);
  const ctx = { ...extra, path, detail: detail || '' };
  return {
    kind,
    path,
    detail: detail || '',
    directions: template(ctx),
    ...extra
  };
}

/** 对比两份 IR。options.verifiedRenames: Set<path> 表示已经用旧样例验证可读的改名 */
export function compareContracts(oldIr, newIr, options = {}) {
  const verifiedRenames = options.verifiedRenames || new Set();
  const changes = [];
  compareType(oldIr.root, newIr.root, [], changes, verifiedRenames);
  return {
    changeCount: changes.length,
    changes,
    summary: summarize(changes)
  };
}

function summarize(changes) {
  const pick = (direction) =>
    changes.reduce((acc, c) => worse(acc, c.directions[direction].verdict), VERDICT.PASS);
  const backward = pick('backward');
  const forward = pick('forward');
  const consumer = pick('consumer');
  const overall = worse(worse(backward, forward), consumer);
  return {
    backward,
    forward,
    consumer,
    overall,
    fullyCompatible: overall === VERDICT.PASS,
    counts: changes.reduce((acc, c) => {
      acc[c.kind] = (acc[c.kind] || 0) + 1;
      return acc;
    }, {})
  };
}

function compareType(oldType, newType, path, changes, verifiedRenames, isFieldWrapped = false) {
  // 可空性在字段包装层（compareField）统一比较，避免重复上报；
  // 非字段包装的节点（根、数组元素、map 值、union 成员）在此处比较。
  if (!isFieldWrapped && !!oldType.nullable !== !!newType.nullable) {
    changes.push(
      makeChange(
        oldType.nullable ? 'nullable-to-non' : 'non-to-nullable',
        joinPath(path),
        oldType.nullable ? '可空 -> 非空' : '非空 -> 可空'
      )
    );
  }

  if (oldType.kind !== newType.kind) {
    changes.push(
      makeChange('type-changed', joinPath(path), '', {
        oldType: labelOf(oldType),
        newType: labelOf(newType)
      })
    );
    return;
  }

  switch (oldType.kind) {
    case 'primitive':
      comparePrimitive(oldType, newType, path, changes);
      break;
    case 'enum':
      compareEnum(oldType, newType, path, changes);
      break;
    case 'record':
      compareRecord(oldType, newType, path, changes, verifiedRenames);
      break;
    case 'array':
      compareType(oldType.items, newType.items, [...path, '[]'], changes, verifiedRenames);
      break;
    case 'map':
      compareType(oldType.values, newType.values, [...path, '{}'], changes, verifiedRenames);
      break;
    case 'union':
      compareUnion(oldType, newType, path, changes, verifiedRenames);
      break;
    case 'fixed':
      if (oldType.size !== newType.size) {
        changes.push(
          makeChange('type-changed', joinPath(path), `fixed 长度 ${oldType.size} -> ${newType.size}`, {
            oldType: `fixed(${oldType.size})`,
            newType: `fixed(${newType.size})`
          })
        );
      }
      break;
    case 'ref':
      if (oldType.name !== newType.name) {
        changes.push(
          makeChange('type-changed', joinPath(path), `命名引用 ${oldType.name} -> ${newType.name}`, {
            oldType: oldType.name,
            newType: newType.name
          })
        );
      }
      break;
    case 'any':
      break;
    default:
      break;
  }
}

function labelOf(t) {
  if (t.kind === 'primitive') return t.name + (t.nullable ? '?' : '');
  if (t.kind === 'enum') return `enum(${t.enumName || 'anonymous'})`;
  if (t.kind === 'record') return `record(${t.recordName || 'anonymous'})`;
  if (t.kind === 'array') return `array<${labelOf(t.items)}>`;
  if (t.kind === 'map') return `map<${labelOf(t.values)}>`;
  if (t.kind === 'union') return `union<${t.types.map(labelOf).join('|')}>`;
  if (t.kind === 'fixed') return `fixed(${t.size})`;
  if (t.kind === 'ref') return `ref(${t.name})`;
  return t.kind;
}

function comparePrimitive(oldType, newType, path, changes) {
  if (oldType.name === newType.name) return;
  const ow = widthOf(oldType.name);
  const nw = widthOf(newType.name);
  const pair = `${oldType.name}|${newType.name}`;
  // 只有同属宽度族（数值族或 bytes/string 对）才比较宽窄；跨族一律类型族变化
  const sameFamily =
    (ow !== null && nw !== null) &&
    (isNumericWidth(oldType.name) === isNumericWidth(newType.name));
  if (ow !== null && nw !== null && ow === nw && SAME_WIDTH.has(pair)) return; // int/long 同宽
  if (sameFamily && ow < nw) {
    changes.push(makeChange('type-widened', joinPath(path), `${oldType.name} -> ${newType.name}`, {
      oldType: oldType.name,
      newType: newType.name
    }));
  } else if (sameFamily && ow > nw) {
    changes.push(makeChange('type-narrowed', joinPath(path), `${oldType.name} -> ${newType.name}`, {
      oldType: oldType.name,
      newType: newType.name
    }));
  } else {
    changes.push(makeChange('type-changed', joinPath(path), `${oldType.name} -> ${newType.name}`, {
      oldType: oldType.name,
      newType: newType.name
    }));
  }
}

function isNumericWidth(name) {
  return ['int', 'long', 'float', 'double'].includes(name);
}

function compareEnum(oldType, newType, path, changes) {
  const oldSet = new Set(oldType.symbols);
  const newSet = new Set(newType.symbols);
  for (const s of newType.symbols) {
    if (!oldSet.has(s)) {
      changes.push(makeChange('enum-symbol-added', joinPath(path), s));
    }
  }
  for (const s of oldType.symbols) {
    if (!newSet.has(s)) {
      changes.push(makeChange('enum-symbol-removed', joinPath(path), s));
    }
  }
}

function compareRecord(oldRec, newRec, path, changes, verifiedRenames) {
  const oldByName = new Map(oldRec.fields.map((f) => [f.name, f]));
  const newByName = new Map(newRec.fields.map((f) => [f.name, f]));
  const matchedOld = new Set();
  const matchedNew = new Set();

  // 第一步：按别名识别改名。
  // 两种声明方式等价：新字段 aliases 含旧字段名，或旧字段 aliases 含新字段名。
  for (const [newName, nf] of newByName) {
    if (oldByName.has(newName)) continue;
    let renameFrom = null;
    for (const [oldName, of] of oldByName) {
      if ((nf.aliases || []).includes(oldName) || (of.aliases || []).includes(newName)) {
        renameFrom = oldName;
        break;
      }
    }
    if (!renameFrom) continue;
    const of = oldByName.get(renameFrom);
    matchedOld.add(renameFrom);
    matchedNew.add(newName);
    const fieldPath = joinPath([...path, newName]);
    const aliasSet = [...new Set([...(of.aliases || []), ...(nf.aliases || [])])];
    const kind = verifiedRenames.has(fieldPath) ? 'renamed-alias-verified' : 'renamed-alias-unverified';
    changes.push(
      makeChange(kind, fieldPath, aliasSet.join(', '), {
        oldName: renameFrom,
        newName,
        aliases: aliasSet
      })
    );
    compareType(of.type, nf.type, [...path, newName], changes, verifiedRenames);
  }

  // 第二步：无别名改名启发式——剩余字段恰好一对一增删且类型结构相同，识别为"改名无别名"
  const leftoverOld = [...oldByName.entries()].filter(([name]) => !matchedOld.has(name) && !newByName.has(name));
  const leftoverNew = [...newByName.entries()].filter(([name]) => !matchedNew.has(name) && !oldByName.has(name));
  if (leftoverOld.length === 1 && leftoverNew.length === 1) {
    const [oldName, of] = leftoverOld[0];
    const [newName, nf] = leftoverNew[0];
    if (structuralSameType(of.type, nf.type)) {
      matchedOld.add(oldName);
      matchedNew.add(newName);
      const fieldPath = joinPath([...path, newName]);
      changes.push(
        makeChange('renamed-no-alias', fieldPath, '', { oldName, newName, aliases: [] })
      );
      compareType(of.type, nf.type, [...path, newName], changes, verifiedRenames);
    }
  }

  for (const [name, nf] of newByName) {
    if (matchedNew.has(name)) continue;
    const of = oldByName.get(name);
    const fieldPath = joinPath([...path, name]);
    if (!of) {
      // 新增字段：可选、可空、默认值三类严格区分
      if (!nf.required) {
        changes.push(makeChange('added-optional', fieldPath, describeField(nf), { field: nf }));
      } else if (nf.hasDefault) {
        changes.push(
          makeChange('added-required-with-default', fieldPath, describeField(nf), { field: nf })
        );
      } else {
        changes.push(makeChange('added-required', fieldPath, describeField(nf), { field: nf }));
      }
      continue;
    }
    matchedOld.add(name);
    compareField(of, nf, [...path, name], changes, verifiedRenames);
  }

  for (const [name, of] of oldByName) {
    if (matchedOld.has(name)) continue;
    if (!newByName.has(name)) {
      const fieldPath = joinPath([...path, name]);
      const claimed = [...newByName.values()].some(
        (nf) => (nf.aliases || []).includes(name)
      );
      if (claimed) continue;
      changes.push(
        makeChange(
          of.required ? 'removed-required' : 'removed-optional',
          fieldPath,
          describeField(of),
          { field: of }
        )
      );
    }
  }
}

/** 忽略可空性/别名/默认值，只比较类型骨架，用于无别名改名的结构同源判断 */
function structuralSameType(a, b) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'primitive':
      return a.name === b.name;
    case 'enum':
      return JSON.stringify([...a.symbols].sort()) === JSON.stringify([...b.symbols].sort());
    case 'record':
      if (a.fields.length !== b.fields.length) return false;
      return a.fields.every((f, i) => f.name === b.fields[i].name && structuralSameType(f.type, b.fields[i].type));
    case 'array':
      return structuralSameType(a.items, b.items);
    case 'map':
      return structuralSameType(a.values, b.values);
    case 'union':
      if (a.types.length !== b.types.length) return false;
      return a.types.every((t, i) => structuralSameType(t, b.types[i]));
    case 'fixed':
      return a.size === b.size;
    default:
      return true;
  }
}

function describeField(f) {
  const flags = [];
  flags.push(f.required ? '必填' : '可选');
  if (f.type.nullable || f.nullable) flags.push('可空');
  if (f.hasDefault) flags.push(`默认=${safeDefault(f.default)}`);
  return `${labelOf(f.type)}（${flags.join('，')}）`;
}

function safeDefault(v) {
  if (v === undefined) return '∅';
  const s = JSON.stringify(v);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

function compareField(of, nf, path, changes, verifiedRenames) {
  // 必填性（可选 vs 必填）独立比较
  if (of.required !== nf.required) {
    changes.push(
      makeChange(
        of.required ? 'required-to-optional' : 'optional-to-required',
        joinPath(path),
        describeField(nf),
        { hasDefault: nf.hasDefault }
      )
    );
  }
  // 可空性独立比较：标记可能落在字段包装上，也可能落在类型节点上
  const oldNullable = !!(of.nullable || of.type?.nullable);
  const newNullable = !!(nf.nullable || nf.type?.nullable);
  if (oldNullable !== newNullable) {
    changes.push(
      makeChange(
        oldNullable ? 'nullable-to-non' : 'non-to-nullable',
        joinPath(path),
        oldNullable ? '可空 -> 非空' : '非空 -> 可空'
      )
    );
  }
  // 默认值独立比较（与可选/可空不混为一类）
  const oldHas = of.hasDefault;
  const newHas = nf.hasDefault;
  if (oldHas || newHas) {
    const oldDef = oldHas ? JSON.stringify(of.default) : '无默认';
    const newDef = newHas ? JSON.stringify(nf.default) : '无默认';
    if (oldDef !== newDef) {
      changes.push(makeChange('default-changed', joinPath(path), `${oldDef} -> ${newDef}`));
    }
  }
  compareType(of.type, nf.type, path, changes, verifiedRenames, true);
}

function compareUnion(oldType, newType, path, changes, verifiedRenames) {
  // 按类型标签配对比较；无法配对的成员按整体类型族变化上报
  const oldLabels = new Map(oldType.types.map((t) => [labelOf(t), t]));
  const used = new Set();
  for (const nt of newType.types) {
    const label = labelOf(nt);
    const ot = oldLabels.get(label);
    if (ot) {
      used.add(label);
      compareType(ot, nt, path, changes, verifiedRenames);
    } else {
      changes.push(
        makeChange('type-changed', joinPath(path), `union 新增成员 ${label}`, {
          oldType: 'union',
          newType: label
        })
      );
    }
  }
  for (const [label, ot] of oldLabels) {
    if (!used.has(label)) {
      changes.push(
        makeChange('type-changed', joinPath(path), `union 移除成员 ${label}`, {
          oldType: label,
          newType: 'union'
        })
      );
    }
  }
}
