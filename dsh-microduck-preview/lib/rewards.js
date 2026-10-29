import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[\w.:@-]{1,160}$/.test(value) || ['.', '..'].includes(value)) throw new Error('无效的会话或任务标识。');
  return value;
};
export const catalogFile = (config) => path.join(config.pluginDir ?? root, 'rewards/catalog.json');
export const loadCatalog = (config) => JSON.parse(fs.readFileSync(catalogFile(config), 'utf8'));
const checksCache = new Map();
export function validateCatalog(config, refresh = false) {
  const file = catalogFile(config);
  const key = JSON.stringify([config.python, config.assetsRoot, file]);
  const cached = checksCache.get(key);
  if (!refresh && cached && Date.now() - cached.time < 5000) return cached.result;
  let result;
  try {
    result = JSON.parse(execFileSync(config.python, ['-B', path.join(config.pluginDir ?? root, 'pipeline/reward_catalog.py'), '--asset-root', config.assetsRoot, '--catalog', file], { timeout: 15_000, maxBuffer: 500_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) { result = loadCatalog(config).terms.map((t) => ({ id: t.id, ok: false, error: `无法检查训练函数：${error.message.slice(0, 240)}` })); }
  checksCache.set(key, { time: Date.now(), result });
  return result;
}
export function catalogTerm(config, id) {
  const term = loadCatalog(config).terms.find((entry) => entry.id === id);
  if (!term) throw new Error(`目录中没有奖励项 ${id}。`);
  return term;
}
export function sessionRewardsPath(config, sessionId, taskId = 'draft') {
  return path.join(config.dataDir, 'sessions', identifier(sessionId), 'rewards', `${identifier(taskId)}.json`);
}
const defaultEntry = (term) => ({ id: term.id, enabled: true, weight: term.weight.default,
  params: Object.fromEntries(Object.entries(term.params || {}).map(([k, v]) => [k, v.default])), active_phases: ['all'], status: 'explanation_only' });
export function loadSelection(config, sessionId, pattern = 'line', taskId) {
  const catalog = loadCatalog(config);
  const file = sessionRewardsPath(config, sessionId, taskId ?? `draft-${pattern}`);
  if (fs.existsSync(file)) return { catalog, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const valid = new Set(validateCatalog(config).filter((v) => v.ok).map((v) => v.id));
  const terms = (catalog.presets?.[pattern === 'hover' ? 'hover' : 'walk'] ?? []).filter((id) => valid.has(id)).map((id) => defaultEntry(catalogTerm(config, id)));
  const current = { catalog, schema_version: 1, task_id: taskId ?? null, pattern, version: hash(terms), terms };
  if (taskId) return { catalog, ...persist(config, sessionId, current) };
  return current;
}
/** Carry weight choices forward to the new action while retaining its preset. */
export function inheritSelection(config, sessionId, pattern, taskId, previous) {
  const current = loadSelection(config, sessionId, pattern, taskId);
  if (!previous) return current;
  for (const entry of current.terms) {
    const old = previous.terms.find((item) => item.id === entry.id);
    if (old) Object.assign(entry, { weight: old.weight, enabled: old.enabled });
  }
  return persist(config, sessionId, current);
}
function persist(config, sessionId, current) {
  const { catalog, ...document } = current;
  document.version = hash(document.terms);
  document.updated_at = new Date().toISOString();
  const file = sessionRewardsPath(config, sessionId, current.task_id ?? `draft-${current.pattern}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const versionFile = path.join(path.dirname(file), 'versions', `${current.task_id ?? `draft-${current.pattern}`}-${document.version}.json`);
  fs.mkdirSync(path.dirname(versionFile), { recursive: true });
  if (!fs.existsSync(versionFile)) fs.writeFileSync(versionFile, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(document, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
  return document;
}
export function listRewards(config, sessionId, pattern, taskId) {
  const current = loadSelection(config, sessionId, pattern, taskId);
  const checks = validateCatalog(config);
  return { catalog: current.catalog.terms.map((t) => ({ ...t, validation: checks.find((v) => v.id === t.id) })), selection: current.terms, version: current.version, task_id: current.task_id, presets: current.catalog.presets };
}
function requireValid(config, id) {
  const result = validateCatalog(config, true).find((v) => v.id === id);
  if (!result?.ok) throw new Error(`${id} 不可启用：${result?.error ?? '函数未解析'}。`);
}
export function addReward(config, sessionId, id, pattern, taskId) {
  const current = loadSelection(config, sessionId, pattern, taskId);
  const term = catalogTerm(config, id); requireValid(config, id);
  const entry = current.terms.find((t) => t.id === id);
  if (entry) entry.enabled = true; else current.terms.push(defaultEntry(term));
  return persist(config, sessionId, current);
}
export function removeReward(config, sessionId, id, pattern, taskId) {
  catalogTerm(config, id);
  const current = loadSelection(config, sessionId, pattern, taskId);
  current.terms = current.terms.map((t) => t.id === id ? { ...t, enabled: false } : t);
  return persist(config, sessionId, current);
}
export function setReward(config, sessionId, id, { weight, params, active_phases } = {}, pattern, taskId) {
  const current = loadSelection(config, sessionId, pattern, taskId);
  const term = catalogTerm(config, id); requireValid(config, id);
  let entry = current.terms.find((t) => t.id === id);
  if (!entry) { entry = defaultEntry(term); current.terms.push(entry); }
  if (weight !== undefined) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < term.weight.min || weight > term.weight.max || (term.kind === 'reward' ? weight < 0 : weight > 0)) throw new Error(`${id} 权重必须在 ${term.weight.min}–${term.weight.max}；奖励 ≥0，惩罚 ≤0。`);
    entry.weight = weight;
  }
  if (params !== undefined) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params 必须为对象。');
    for (const [key, value] of Object.entries(params)) {
      const spec = term.params?.[key];
      if (!spec || typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) throw new Error(`${id}.${key} 参数未知或超出范围。`);
      entry.params[key] = value;
    }
    if (entry.params.threshold_min >= entry.params.threshold_max) throw new Error('threshold_min 必须小于 threshold_max。');
  }
  if (active_phases !== undefined) {
    if (!Array.isArray(active_phases) || !active_phases.length || active_phases.some((v) => !['all', 'walk', 'turn', 'hover', 'stand', 'transition'].includes(v))) throw new Error('生效时段只允许 all / walk / turn / hover / stand / transition。');
    entry.active_phases = [...new Set(active_phases)];
  }
  entry.enabled = true;
  return persist(config, sessionId, current);
}
export function exportRewards(config, sessionId, pattern, taskId) {
  const current = loadSelection(config, sessionId, pattern, taskId);
  const terms = current.terms.filter((t) => t.enabled).map((entry) => {
    requireValid(config, entry.id);
    const term = catalogTerm(config, entry.id);
    if (!Number.isFinite(entry.weight) || entry.weight < term.weight.min || entry.weight > term.weight.max) throw new Error('保存的奖励权重无效。');
    for (const [key, value] of Object.entries(entry.params ?? {})) {
      const spec = term.params?.[key];
      if (!spec || !Number.isFinite(value) || value < spec.min || value > spec.max) throw new Error(`保存的 ${entry.id}.${key} 参数无效。`);
    }
    const active = entry.active_phases ?? ['all'];
    if (!active.length || active.some((v) => !['all', 'walk', 'turn', 'hover', 'stand', 'transition'].includes(v))) throw new Error('保存的生效时段无效。');
    return { ...entry, kind: term.kind, function: term.function, params: { ...term.fixed_params, ...entry.params }, source: validateCatalog(config).find((v) => v.id === entry.id) };
  });
  return { schema_version: 1, version: hash(terms), task_id: taskId, pattern, terms, training_started: false, recipe_change_requires_new_trial: true };
}
