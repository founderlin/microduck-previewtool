import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { doctor } from './config.mjs';
import { createWorkbench, workbenchAsset } from '../../dsh-microduck-preview/lib/workbench.js';
import { serveVideo } from '../../dsh-microduck-preview/lib/http.js';

const PREFIX = '/api/microduck';
const MIME = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };

function send(res, code, value) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(value) + '\n';
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
function session(value) {
  if (typeof value !== 'string' || !/^[\w.:@-]{1,160}$/.test(value)) throw bad('需要 session_id：1–160 位字母、数字、下划线、点、冒号、@ 或连字符。');
  return value;
}
async function body(req) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw bad('请发送 application/json。', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw bad('请求参数过大，最大 32 KB。', 413);
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error();
    return result;
  } catch { throw bad('请求体必须为有效的 JSON 对象。'); }
}

/** Loopback-only adapter; no dependency on DSH services, slots, or authentication. */
export async function startServer(config) {
  if (config.host !== '127.0.0.1') throw new Error('预览服务只允许监听 127.0.0.1。');
  const importPlugin = (file) => import(pathToFileURL(path.join(config.pluginDir, 'lib', file)).href);
  const [{ PreviewStore }, { FramePool }, { createApiHandler }, spec] = await Promise.all([
    importPlugin('tasks.js'), importPlugin('frames.js'), importPlugin('http.js'), importPlugin('spec.js'),
  ]);
  // The DSH store persists live child handles on cancellation; exclude those in this adapter.
  class LocalStore extends PreviewStore {
    persist(record) {
      const { _dir, _child, ...value } = record;
      const file = path.join(this.tasksDir, record.id, 'task.json');
      const temp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
      fs.renameSync(temp, file);
    }
    async run(record) {
      const dir = path.join(this.tasksDir, record.id);
      record.status = 'running';
      record.started_at = record.updated_at = new Date().toISOString();
      fs.writeFileSync(path.join(dir, 'params.json'), JSON.stringify(record.params, null, 2));
      this.persist(record);
      if (record.engine === 'real') await this.runReal(record); else await this.runDemo(record);
      if (record.status === 'error') return;
      this.hydrate(record);
      record.finished_at = new Date().toISOString();
      record.status = 'done';
      this.settle(record);
    }
    dispose() {
      const queued = this.queue.splice(0);
      for (const record of queued) this.cancel(record, '本地预览服务关闭，任务中断。');
      if (this.running) this.cancel(this.running, '本地预览服务关闭，任务中断。');
    }
  }
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const logger = (...args) => console.error('[microduck]', ...args);
  const store = new LocalStore({ pluginDir: config.pluginDir, config, logger }).init();
  const frames = new FramePool({ pluginDir: config.pluginDir, python: config.python, assetRoot: config.assetsRoot, idleMs: config.idleMs ?? 45_000, maxWorkers: 2, logger });
  // In a saturated pool don't silently allocate a third heavyweight GL renderer.
  const render = frames.render.bind(frames);
  let lastRender = Promise.resolve();
  frames.render = async (...args) => {
    const pending = lastRender.then(() => render(...args));
    lastRender = pending.catch(() => {});
    return pending;
  };
  let origin, server, closing = false;
  let dependencyCheck;
  const instanceId = randomUUID();
  const serviceFile = path.join(config.dataDir, 'service.json');
  const getSessionTasks = (id) => store.listForSession(id, 200);
  const templates = (id) => ({
    ...spec.buildTemplates({ recentTasks: getSessionTasks(id).slice(0, 5).map((r) => store.publicView(r)) }),
    runtime: 'codex-local',
    tuning_rule: '微调仅继承当前 session_id 最近一个未失败任务的参数；也可用 base_task_id 指定基准。',
    output_contract: { status_values: ['queued', 'running', 'done', 'error'], on_done: '使用 viewer_url 打开 Codex 右侧浏览器面板；video_path 是本机 MP4。', on_running: '使用 status 查询同一 task_id，不要重复提交。', on_error: '如实转述 error、DEMO 和降级原因。' },
  });
  const view = (record) => ({
    ...store.detailView(record),
    task_id: record.id,
    ok: record.status === 'done',
    viewer_url: `${origin}/?session_id=${encodeURIComponent(record.session_id)}&task_id=${record.id}`,
    video_url: record.video_url ? `${origin}${record.video_url}?session_id=${encodeURIComponent(record.session_id)}` : null,
    warnings: [...new Set([...(record.warnings ?? []), ...(record.metrics?.warnings ?? [])])],
  });
  const sharedHandler = createApiHandler({ store, frames, templates: () => ({}), logger });
  const owns = (id, owner) => {
    if (!/^[\w-]{1,100}$/.test(id)) throw bad('任务不存在。', 404);
    const record = store.get(id);
    if (!record || record.session_id !== owner) throw bad('当前对话中没有这个任务。', 404);
    // Persisted records may not point outside the task's own artifact directory.
    const taskRoot = fs.realpathSync(store.tasksDir);
    const dir = fs.realpathSync(path.join(store.tasksDir, id));
    if (!dir.startsWith(taskRoot + path.sep)) throw bad('无效任务路径。', 403);
    for (const name of ['preview.mp4', 'motion.json', 'run.log']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && !fs.realpathSync(file).startsWith(dir + path.sep)) throw bad('无效产物路径。', 403);
    }
    return record;
  };

  const workbench = createWorkbench({ config, store, send, serveVideo, owns, preview: false });
  server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    try {
      if (!origin || req.headers.host !== new URL(origin).host) throw bad('无效的本机 Host。', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw bad('不允许跨来源请求。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw bad('不允许跨站请求。', 403);
      const url = new URL(req.url, origin);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) throw bad('路径不存在。', 404);
      const method = req.method;
      const route = pathname.slice(PREFIX.length);
      if (pathname.startsWith(PREFIX + '/')) {
        if (route === '/health' && method === 'GET') {
          return send(res, 200, { ok: true, projectRoot: config.projectRoot, instance_id: instanceId, engine: config.engine, tasks: store.tasks.size, viewer_mode: 'codex-browser-panel', inline_ui: false });
        }
        if (route === '/shutdown' && method === 'POST') {
          const request = await body(req);
          if (request.instance_id !== instanceId) throw bad('服务实例不匹配，未停止其他进程。', 409);
          send(res, 200, { ok: true });
          setImmediate(() => close());
          return;
        }
        if (route === '/preview' && method === 'POST') {
          if (closing) throw bad('服务正在关闭。', 503);
          const input = await body(req);
          const owner = session(input.session_id);
          if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw bad('params 必须为对象；使用 {} 请求默认动作。');
          if (input.wait_ms !== undefined && (!Number.isFinite(input.wait_ms) || input.wait_ms < 0 || input.wait_ms > 25_000)) throw bad('wait_ms 范围为 0–25000。');
          const previous = input.base_task_id ? owns(input.base_task_id, owner) : getSessionTasks(owner).find((r) => r.status !== 'error');
          let validated;
          try { validated = spec.validateInput(spec.inheritParams(input.params, previous?.params).merged); }
          catch (e) { throw bad(e.message); }
          if (config.engine !== 'demo') {
            dependencyCheck ??= doctor(config);
            const result = await dependencyCheck;
            if (!result.ok) { dependencyCheck = undefined; throw bad('真实管线依赖检查失败：' + result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)}`).join('；'), 503); }
          }
          const task = store.create(validated.params, { sessionId: owner, warnings: validated.warnings });
          if (input.wait_ms) await store.waitFor(task, input.wait_ms);
          return send(res, 200, view(task));
        }
        if (await workbench(req, res, url)) return;
        const owner = session(url.searchParams.get('session_id'));
        if (route === '/presets' && method === 'GET') return send(res, 200, templates(owner));
        if (route === '/tasks' && method === 'GET') return send(res, 200, { tasks: getSessionTasks(owner).map(view), session_id: owner });
        const parts = route.split('/').filter(Boolean);
        if (parts[0] === 'tasks' && parts[1]) {
          const record = owns(parts[1], owner);
          if (parts.length === 2 && method === 'GET') return send(res, 200, view(record));
          if (parts[2] === 'scene' && parts.length === 3 && method === 'GET') {
            const interactive = record.status === 'done' && record.engine === 'real' && fs.existsSync(path.join(store.tasksDir, record.id, 'motion.json'));
            return send(res, 200, { task_id: record.id, status: record.status, interactive, engine: record.engine, duration_s: record.metrics?.motion_duration_s ?? record.metrics?.duration_s ?? null, fps: record.metrics?.fps ?? null, frames: record.metrics?.frames ?? null, params: record.params, geometry: record.metrics?.geometry ?? null, default_camera: { az: 130, el: -18, dist: 0.70, follow: true }, video_url: view(record).video_url, reason: interactive ? null : record.engine === 'demo' ? 'DEMO 片段不是本次参数渲染的动作，仅可播放录像。' : '任务未完成或缺少 motion.json。' });
          }
          if (parts.length === 3 && ['frame', 'video', 'metrics'].includes(parts[2]) && ['GET', 'HEAD'].includes(method)) {
            // The DSH handler treats Number(null) as zero; specify actual camera defaults here.
            if (parts[2] === 'frame') {
              for (const [key, value] of Object.entries({ t: 0, az: 130, el: -18, dist: 0.70, w: 720, h: 480, q: 80, shadows: 0 })) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
              req.url = url.pathname + url.search;
            }
            return await sharedHandler(req, res);
          }
        }
        if (route === '/viewer/release' && method === 'POST') {
          const record = owns(url.searchParams.get('task_id') ?? '', owner);
          return send(res, 200, { released: frames.release(record.id), task_id: record.id });
        }
        return send(res, 404, { error: 'not_found' });
      }
      const asset = MIME[pathname];
      if (asset && (method === 'GET' || method === 'HEAD')) {
        const content = workbenchAsset(config, asset[0]);
        res.writeHead(200, { 'content-type': asset[1], 'content-length': content.length, 'cache-control': 'no-store' });
        res.end(method === 'HEAD' ? undefined : content);
        return;
      }
      send(res, 404, { error: 'not_found' });
    } catch (e) { send(res, e.status ?? (e instanceof URIError ? 400 : 500), { ok: false, error: e.message }); }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  } catch (e) { frames.dispose(); store.dispose(); throw e; }
  origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(serviceFile, JSON.stringify({ pid: process.pid, origin, projectRoot: config.projectRoot, started_at: new Date().toISOString(), instance_id: instanceId }, null, 2), { mode: 0o600 });
  let closingPromise;
  async function close() {
    if (closingPromise) return closingPromise;
    closing = true;
    frames.dispose();
    store.dispose();
    closingPromise = new Promise((resolve) => {
      server.close(() => {
        try { if (JSON.parse(fs.readFileSync(serviceFile, 'utf8')).instance_id === instanceId) fs.unlinkSync(serviceFile); } catch { /* already removed */ }
        resolve();
      });
      server.closeIdleConnections();
    });
    return closingPromise;
  }
  return { server, origin, close };
}
