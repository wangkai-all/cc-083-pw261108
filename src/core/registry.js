// 契约登记与版本管理（纯逻辑 + 可注入存储）。
// 关键规则：
//  1. 同一数据集下，同版本号 + 同内容哈希 -> 幂等返回；同版本号 + 不同内容 -> 拒绝覆盖。
//  2. 解析失败：原始文件、文件名、错误全部保留，状态标 "unevaluated"，不参与任何通过结论。
//  3. 只有解析成功的版本可发布；发布版本形成可比较的历史契约链。

import { canonicalJson, sha256Hex } from './util.js';
import { parseJsonSchema, SchemaParseError } from './parseJsonSchema.js';
import { parseAvro, AvroParseError } from './parseAvro.js';
import { compareContracts } from './schemaCompare.js';
import { validateOldSampleAgainstNew, validateSample } from './validate.js';

export const VERSION_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  UNEVALUATED: 'unevaluated'
});

export const IMPORT_FORMAT = Object.freeze({
  AUTO: 'auto',
  JSON_SCHEMA: 'json-schema',
  AVRO: 'avro'
});

export class RegistryError extends Error {}
export class VersionConflictError extends RegistryError {
  constructor(version, existingHash, incomingHash) {
    super(`版本 ${version} 已存在且内容不同，拒绝覆盖（已存在 ${existingHash.slice(0, 10)}…，新内容 ${incomingHash.slice(0, 10)}…）`);
    this.name = 'VersionConflictError';
    this.code = 'VERSION_CONFLICT';
    this.existingHash = existingHash;
    this.incomingHash = incomingHash;
  }
}

export function detectFormat(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.type === 'string' && ['record', 'enum', 'array', 'map', 'fixed'].includes(raw.type)) {
      return 'avro';
    }
    if (raw.$schema || raw.properties || raw.required || raw.additionalProperties !== undefined) {
      return 'json-schema';
    }
    if (raw.type && typeof raw.type === 'object') return 'avro';
  }
  if (Array.isArray(raw)) return 'avro'; // Avro union 根
  return 'json-schema';
}

function normalizeFormat(raw, requested) {
  if (requested && requested !== IMPORT_FORMAT.AUTO) return requested;
  return detectFormat(raw);
}

export class ContractRegistry {
  constructor(storage) {
    this.storage = storage;
  }

  loadState() {
    return this.storage.load() || { datasets: {} };
  }

  saveState(state) {
    this.storage.save(state);
  }

  listDatasets() {
    return Object.values(this.loadState().datasets).sort((a, b) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
  }

  getDataset(id) {
    return this.loadState().datasets[id] || null;
  }

  createDataset({ name, description = '', owner = '' }) {
    if (!name || !name.trim()) throw new RegistryError('数据集名称不能为空');
    const state = this.loadState();
    const id = `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    state.datasets[id] = {
      id,
      name: name.trim(),
      description,
      owner,
      createdAt: now,
      updatedAt: now,
      versions: []
    };
    this.saveState(state);
    return state.datasets[id];
  }

  /**
   * 导入一个定义。
   * @param {object} input { datasetId, version, fileName, text, format?, raw? }
   *   text 为文件原文；raw 可选（已解析 JSON，测试用）
   * @returns {{ status:'duplicated'|'imported'|'unevaluated', version: object }}
   */
  async importDefinition(input) {
    const { datasetId, version, fileName } = input;
    if (!version || !String(version).trim()) throw new RegistryError('版本号不能为空');
    const state = this.loadState();
    const dataset = state.datasets[datasetId];
    if (!dataset) throw new RegistryError(`数据集不存在: ${datasetId}`);

    const text = input.text ?? (input.raw !== undefined ? JSON.stringify(input.raw) : '');
    const now = new Date().toISOString();

    let raw;
    try {
      raw = input.raw !== undefined ? input.raw : JSON.parse(text);
    } catch (e) {
      // 语法失败：按原文指纹留存，标记未评估
      const rawHash = await sha256Hex(canonicalJson({ v: text }));
      return { status: 'unevaluated', version: this.#persistUnevaluated(state, dataset, {
        version, fileName, text, hash: rawHash, now,
        error: `JSON 语法解析失败: ${e.message}`,
        errorStage: 'json-parse'
      }) };
    }

    // 指纹基于解析后的逻辑结构：键序、空白差异不影响内容同一性
    const contentHash = await sha256Hex(canonicalJson(raw));

    // 同版本号检查
    const existing = dataset.versions.find((v) => v.version === String(version).trim());
    if (existing) {
      if (existing.contentHash === contentHash) {
        return { status: 'duplicated', version: existing }; // 幂等：逻辑内容相同
      }
      throw new VersionConflictError(version, existing.contentHash, contentHash);
    }

    const format = normalizeFormat(raw, input.format);
    let ir;
    try {
      ir = format === 'avro' ? parseAvro(raw) : parseJsonSchema(raw);
    } catch (e) {
      return { status: 'unevaluated', version: this.#persistUnevaluated(state, dataset, {
        version, fileName, text, hash: contentHash, now,
        error: e.message,
        errorLocation: e.location || null,
        errorStage: 'schema-parse',
        detectedFormat: format
      }) };
    }

    const record = {
      id: `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      version: String(version).trim(),
      fileName: fileName || 'inline.json',
      contentHash,
      format,
      status: VERSION_STATUS.DRAFT,
      createdAt: now,
      publishedAt: null,
      ir,
      rawDefinition: raw,
      parseError: null
    };
    dataset.versions.push(record);
    dataset.updatedAt = now;
    this.saveState(state);
    return { status: 'imported', version: record };
  }

  #persistUnevaluated(state, dataset, { version, fileName, text, hash, now, error, errorLocation, errorStage, detectedFormat }) {
    // 原始文件保留，标记未评估；不生成 IR，不参与比较与通过结论
    const record = {
      id: `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      version: String(version).trim(),
      fileName: fileName || 'inline.json',
      contentHash: hash,
      format: detectedFormat || 'unknown',
      status: VERSION_STATUS.UNEVALUATED,
      createdAt: now,
      publishedAt: null,
      ir: null,
      rawDefinition: null,
      rawText: text,
      parseError: { message: error, location: errorLocation || null, stage: errorStage }
    };
    dataset.versions.push(record);
    dataset.updatedAt = now;
    this.saveState(state);
    return record;
  }

  publishVersion(datasetId, versionId) {
    const state = this.loadState();
    const dataset = state.datasets[datasetId];
    const record = dataset?.versions.find((v) => v.id === versionId);
    if (!record) throw new RegistryError('版本不存在');
    if (record.status === VERSION_STATUS.UNEVALUATED) {
      throw new RegistryError('未评估的定义不能发布：请先修复解析错误后重新导入');
    }
    if (record.status === VERSION_STATUS.PUBLISHED) return record;
    record.status = VERSION_STATUS.PUBLISHED;
    record.publishedAt = new Date().toISOString();
    dataset.updatedAt = new Date().toISOString();
    this.saveState(state);
    return record;
  }

  /**
   * 比较两个版本。任一为未评估则直接拒绝（未解析定义不参与通过结论）。
   * verifiedRenamePaths 由样本验证阶段产出。
   */
  compareVersions(datasetId, oldVersionId, newVersionId, verifiedRenamePaths = []) {
    const state = this.loadState();
    const dataset = state.datasets[datasetId];
    const oldV = dataset?.versions.find((v) => v.id === oldVersionId);
    const newV = dataset?.versions.find((v) => v.id === newVersionId);
    if (!oldV || !newV) throw new RegistryError('比较的版本不存在');
    for (const v of [oldV, newV]) {
      if (v.status === VERSION_STATUS.UNEVALUATED || !v.ir) {
        return {
          notEvaluated: true,
          reason: `版本 ${v.version} 未通过解析（${v.parseError?.message ?? '未知错误'}），未解析的定义不参与兼容性结论`
        };
      }
    }
    const result = compareContracts(oldV.ir, newV.ir, {
      verifiedRenames: new Set(verifiedRenamePaths)
    });
    return {
      notEvaluated: false,
      oldVersion: { id: oldV.id, version: oldV.version, format: oldV.format, contentHash: oldV.contentHash },
      newVersion: { id: newV.id, version: newV.version, format: newV.format, contentHash: newV.contentHash },
      ...result
    };
  }

  /** 校验样本：坏样例错误定位到嵌套字段 */
  validateSample(datasetId, versionId, sampleText) {
    const state = this.loadState();
    const record = state.datasets[datasetId]?.versions.find((v) => v.id === versionId);
    if (!record) throw new RegistryError('版本不存在');
    if (record.status === VERSION_STATUS.UNEVALUATED || !record.ir) {
      return { notEvaluated: true, reason: '该版本未通过解析，无法校验样本' };
    }
    let data;
    try {
      data = JSON.parse(sampleText);
    } catch (e) {
      return { notEvaluated: false, valid: false, sampleParseError: `样例 JSON 语法错误: ${e.message}`, errors: [] };
    }
    return { notEvaluated: false, ...validateSample(record.ir, data) };
  }

  /**
   * 改名别名验证：用旧版本样例数据跑新结构，返回验证通过的改名路径集合，
   * 供 compareVersions 把 unverified 升级为 verified。
   */
  verifyRenameWithOldSample(datasetId, oldVersionId, newVersionId, oldSampleText) {
    const state = this.loadState();
    const dataset = state.datasets[datasetId];
    const oldV = dataset?.versions.find((v) => v.id === oldVersionId);
    const newV = dataset?.versions.find((v) => v.id === newVersionId);
    if (!oldV || !newV) throw new RegistryError('版本不存在');
    if (!newV.ir || !oldV.ir) {
      return { notEvaluated: true, reason: '存在未解析版本，无法验证别名' };
    }
    let data;
    try {
      data = JSON.parse(oldSampleText);
    } catch (e) {
      return { notEvaluated: false, valid: false, sampleParseError: `样例 JSON 语法错误: ${e.message}`, verifiedPaths: [], errors: [] };
    }
    const result = validateOldSampleAgainstNew(newV.ir, data);
    // 找出新结构中所有带别名的 record 字段路径，样例通过则视为已验证
    const verifiedPaths = result.valid ? collectAliasedFieldPaths(newV.ir.root, []) : [];
    return { notEvaluated: false, ...result, verifiedPaths };
  }
}

function collectAliasedFieldPaths(node, path) {
  const out = [];
  if (node.kind === 'record') {
    for (const f of node.fields) {
      const p = [...path, f.name];
      if (f.aliases && f.aliases.length) out.push(p.join('.'));
      out.push(...collectAliasedFieldPaths(f.type, p));
    }
  } else if (node.kind === 'array') {
    out.push(...collectAliasedFieldPaths(node.items, [...path, '[]']));
  } else if (node.kind === 'map') {
    out.push(...collectAliasedFieldPaths(node.values, [...path, '{}']));
  } else if (node.kind === 'union') {
    for (const t of node.types) out.push(...collectAliasedFieldPaths(t, path));
  }
  return out;
}
