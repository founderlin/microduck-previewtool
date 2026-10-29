import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { listRewards, addReward, removeReward, setReward, catalogTerm } from './rewards.js';
import { packTask, explainTerm, verifyOwnedPack } from './pack.js';
import { inheritParams, validateInput, summarizeParams } from './spec.js';

export const problem = (message, status = 400) => Object.assign(new Error(message), { status });
export function sessionId(value) {
  if (typeof value !== 'string' || !/^[\w.:@-]{1,160}$/.test(value) || ['.', '..'].includes(value)) throw problem('需要当前对话的稳定 session_id。');
  return value;
}
export async function readBody(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw problem('请发送 application/json。', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw problem('请求参数过大。', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw problem('请求体必须为 JSON 对象。'); }
}
export function ownedTask(store, id, owner) {
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw problem('任务不存在。', 404);
  const record = store.get(id);
  if (!record || record.session_id !== owner) throw problem('当前对话中没有这个任务。', 404);
  return record;
}
export function workbenchAsset(config, name, embedded = false) {
  const dir = path.join(config.pluginDir, 'assets');
  const content = fs.readFileSync(path.join(dir, name));
  if (name !== 'index.html') return content;
  const base = embedded ? '/api/microduck/workbench' : '';
  const version = (file) => createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex').slice(0, 12);
  return Buffer.from(content.toString().replace('href="/styles.css"', `href="${base}/styles.css?v=${version('styles.css')}"`).replace('src="/app.js"', `src="${base}/app.js?v=${version('app.js')}"`));
}

// Shared by the standalone skill viewer and the DSH panel. The host applies its
// authentication/origin fence before dispatch; every recipe is bound to a task.
export function createWorkbench({ config, store, send, serveVideo, frames, owns = (id, owner) => ownedTask(store, id, owner), preview = true }) {
  const inFlight = new Map();
  const serial = (key, fn) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve().then(fn).finally(() => inFlight.delete(key));
    inFlight.set(key, promise); return promise;
  };
  return async (req, res, url) => {
    const route = decodeURIComponent(url.pathname).slice('/api/microduck'.length);
    const method = req.method;
    if (route.startsWith('/workbench') && ['GET', 'HEAD'].includes(method)) {
      const assets = { '/workbench': ['index.html', 'text/html'], '/workbench/': ['index.html', 'text/html'], '/workbench/app.js': ['app.js', 'text/javascript'], '/workbench/styles.css': ['styles.css', 'text/css'] };
      const asset = assets[route]; if (!asset) return false;
      const content = workbenchAsset(config, asset[0], true);
      res.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8`, 'content-length': content.length, 'cache-control': 'no-store' });
      res.end(method === 'HEAD' ? undefined : content); return true;
    }
    const parts = route.split('/').filter(Boolean);
    if (parts[0] === 'packs' && parts.length === 3 && parts[2] === 'verify' && method === 'GET') {
      const owner = sessionId(url.searchParams.get('session_id'));
      send(res, 200, verifyOwnedPack(config, parts[1], owner)); return true;
    }
    if (route === '/preview' && method === 'POST' && preview) {
      const input = await readBody(req); const owner = sessionId(input.session_id);
      if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw problem('params 必须为对象。');
      const previous = input.base_task_id ? owns(input.base_task_id, owner) : store.listForSession(owner).find((r) => r.status !== 'error');
      const validated = validateInput(inheritParams(input.params, previous?.params).merged);
      const record = store.create(validated.params, { sessionId: owner, warnings: validated.warnings });
      send(res, 200, { ...store.detailView(record), task_id: record.id, title: summarizeParams(record.params) }); return true;
    }
    if (route === '/rewards' && ['GET', 'POST'].includes(method)) {
      const owner = sessionId(url.searchParams.get('session_id'));
      const input = method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      const record = input.task_id ? owns(input.task_id, owner) : store.listForSession(owner).find((r) => r.status !== 'error');
      const pattern = record?.params?.pattern ?? input.pattern ?? 'line';
      const args = [config, owner, String(input.id ?? ''), pattern, record?.id];
      let result;
      switch (input.action ?? 'list') {
        case 'list': result = listRewards(config, owner, pattern, record?.id); break;
        case 'add': result = addReward(...args); break;
        case 'remove': result = removeReward(...args); break;
        case 'set': result = setReward(config, owner, args[2], input, pattern, record?.id); break;
        default: throw problem('未知 rewards.action。');
      }
      send(res, 200, result); return true;
    }
    if (parts[0] !== 'tasks' || !['command', 'pack', 'explain', 'export'].includes(parts[2])) return false;
    const owner = sessionId(url.searchParams.get('session_id'));
    const record = owns(parts[1], owner); const taskDir = path.join(store.tasksDir, record.id);
    if (parts.length === 3 && parts[2] === 'export' && method === 'POST') {
      await serial(`export:${record.id}`, () => store.exportVideo(record));
      send(res, 200, { video_url: `/tasks/${record.id}/video` }); return true;
    }
    if (parts.length === 3 && parts[2] === 'command' && method === 'GET') {
      const file = path.join(taskDir, 'command.json'); if (!fs.existsSync(file)) throw problem('任务还没有 command.json。', 404);
      send(res, 200, JSON.parse(fs.readFileSync(file))); return true;
    }
    if (parts.length === 3 && parts[2] === 'pack' && method === 'POST') {
      send(res, 200, { ok: true, ...await serial(`pack:${record.id}`, () => packTask(config, record, owner)) }); return true;
    }
    if (parts.length === 3 && parts[2] === 'explain' && method === 'POST') {
      const input = await readBody(req); const term = catalogTerm(config, String(input.id ?? ''));
      const selected = listRewards(config, owner, record.params.pattern, record.id).selection.find((t) => t.id === term.id);
      const result = await serial(`explain:${record.id}:${term.id}`, () => explainTerm(config, record, { ...term, selected }));
      send(res, 200, { ...result, frame_url: result.status === 'ready' ? `/tasks/${record.id}/explain/${term.id}/${result.cache_key}/frame` : null }); return true;
    }
    if (parts.length === 6 && parts[2] === 'explain' && parts[5] === 'frame' && method === 'GET') {
      catalogTerm(config, parts[3]);
      if (!frames || !/^[a-f0-9]{16}$/.test(parts[4])) throw problem('演示不可用。', 404);
      const dir = path.join(config.dataDir, 'explain', record.id, `${parts[3]}-${parts[4]}`);
      if (!fs.existsSync(path.join(dir, 'motion.json'))) throw problem('演示轨迹不存在。', 404);
      const num = (key, fallback, low, high) => { const raw = url.searchParams.get(key); const n = raw === null ? fallback : Number(raw); return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback; };
      const frame = await frames.render(`explain-${record.id}-${parts[4]}`, dir, { t: num('t',0,0,120), az:num('az',130,-720,720), el:num('el',-18,-89,30), dist:num('dist',.7,.12,2.4), w:720,h:480,quality:80,shadows:false,follow:true });
      res.writeHead(200, { 'content-type':'image/jpeg', 'content-length':frame.bytes, 'cache-control':'no-store' }); res.end(frame.buffer); return true;
    }
    if (parts.length === 6 && parts[2] === 'explain' && parts[5] === 'release' && method === 'POST') {
      catalogTerm(config, parts[3]);
      if (!/^[a-f0-9]{16}$/.test(parts[4])) throw problem('演示不存在。', 404);
      send(res, 200, { released: !!frames?.release(`explain-${record.id}-${parts[4]}`) }); return true;
    }
    if (parts.length === 6 && parts[2] === 'explain' && parts[5] === 'video' && ['GET', 'HEAD'].includes(method)) {
      catalogTerm(config, parts[3]); if (!/^[a-f0-9]{16}$/.test(parts[4])) throw problem('缓存不存在。', 404);
      serveVideo(req, res, path.join(config.dataDir, 'explain', record.id, `${parts[3]}-${parts[4]}`, 'explain.mp4')); return true;
    }
    return false;
  };
}
