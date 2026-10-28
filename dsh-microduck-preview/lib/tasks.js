/**
 * Background preview-task store and runner.
 *
 * One task = one `tasks/<task_id>/` directory holding `params.json`,
 * `preview.mp4`, `metrics.json` and `run.log`. Task directories are the durable
 * record: the store rebuilds its list from disk on startup, so the Web viewer
 * survives page reloads and DSH restarts.
 *
 * Two engines:
 *  - real: `pipeline/run_preview.py` (MuJoCo author -> geometry check -> render)
 *  - demo: a bundled sample clip, used until `pipeline/ready.json` exists; every
 *    result says so, so a demo clip is never presented as the requested motion.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { inferAssetsRoot, DEFAULT_PYTHON } from './runtime.js';
import { loadSelection } from './rewards.js';

const MAX_LOG_TAIL = 1600;
const DEMO_RENDER_MS = 2200;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('aborted')); return; }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

const nowIso = () => new Date().toISOString();

/** Expand a leading `~` and resolve relative paths against the home directory. */
function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(os.homedir(), value);
}

/** Read at most `MAX_LOG_TAIL` bytes from the end of a file. */
function readTail(file) {
  try {
    const stat = fs.statSync(file);
    const length = Math.min(MAX_LOG_TAIL, stat.size);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Persist a task record next to its artefacts. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Build a fresh task id: sortable timestamp + short random suffix. */
function newTaskId(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

/**
 * Task store + single-slot runner.
 *
 * `config` keys (all optional):
 *  - dataDir      task root (default `~/.dsh/microduck-preview`)
 *  - assetsRoot   external microduck-marseille checkout
 *  - python       interpreter with mujoco/imageio/PIL/scipy
 *  - demoVideo    explicit demo clip path (overrides the asset-repo lookup)
 *  - engine       'auto' | 'real' | 'demo'
 *  - waitMs       how long duck_preview blocks before reporting `running`
 */
export class PreviewStore {
  constructor(options = {}) {
    this.pluginDir = options.pluginDir ?? process.cwd();
    this.config = options.config ?? {};
    this.logger = options.logger ?? ((...args) => console.error('[microduck]', ...args));
    this.tasksDir = path.join(expandHome(this.config.dataDir ?? '~/.dsh/microduck-preview'), 'tasks');
    this.python = expandHome(this.config.python ?? process.env.MICRODUCK_PYTHON ?? DEFAULT_PYTHON);
    this.assetsRoot = expandHome(this.config.assetsRoot ?? process.env.MICRODUCK_ASSET_ROOT ?? inferAssetsRoot(this.python));
    this.demoVideoOverride = this.config.demoVideo ? expandHome(this.config.demoVideo) : null;
    this.engineSetting = this.config.engine ?? 'auto';
    this.waitMs = Number.isFinite(this.config.waitMs) ? this.config.waitMs : 90_000;
    this.pipelineScript = path.join(this.pluginDir, 'pipeline', 'run_preview.py');
    this.readyMarker = path.join(this.pluginDir, 'pipeline', 'ready.json');

    /** @type {Map<string, Record<string, unknown>>} */
    this.tasks = new Map();
    this.running = null;
    this.queue = [];
    this.waiters = new Map();
    this.initialised = false;
  }

  /** Create the task root and restore previous task records from disk. */
  init() {
    if (this.initialised) return this;
    this.initialised = true;
    fs.mkdirSync(this.tasksDir, { recursive: true });
    let entries = [];
    try {
      entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    } catch (error) {
      this.logger('cannot list task root', error?.message ?? error);
      return this;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = path.join(this.tasksDir, entry.name, 'task.json');
      if (!fs.existsSync(recordPath)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (!record?.id) continue;
        if (record.status === 'running' || record.status === 'queued') {
          record.status = 'error';
          record.error = record.error ?? 'DSH 进程重启，这次渲染被中断，请重新调用 duck_preview。';
          record.updated_at = nowIso();
          this.persist(record);
        }
        this.tasks.set(record.id, this.hydrate(record));
      } catch (error) {
        this.logger(`skipping unreadable task record ${entry.name}`, error?.message ?? error);
      }
    }
    return this;
  }

  /** Recompute derived fields (video path/url, elapsed time) for one record. */
  hydrate(record) {
    const dir = path.join(this.tasksDir, record.id);
    const videoPath = fs.existsSync(path.join(dir, 'preview.mp4')) ? path.join(dir, 'preview.mp4') : null;
    record._dir = dir;
    record.video_path = videoPath;
    record.video_url = videoPath ? this.videoUrl(record.id) : null;
    if (record.status === 'done' && record.metrics && !record.metrics_summary) {
      record.metrics_summary = this.summarizeMetrics(record.metrics);
    }
    return record;
  }

  /** Persist a record's public view (the `_dir` handle is not serialised). */
  persist(record) {
    const { _dir, _child, ...rest } = record;
    try {
      writeJsonAtomic(path.join(this.tasksDir, record.id, 'task.json'), rest);
    } catch (error) {
      this.logger('cannot persist task', record.id, error?.message ?? error);
    }
  }

  /** Browser URL of a task's mp4, served by the plugin's Range route. */
  videoUrl(taskId) {
    return `/api/microduck/tasks/${encodeURIComponent(taskId)}/video`;
  }

  /** Which engine a new task will use, and why. */
  resolveEngine() {
    if (this.engineSetting === 'demo') {
      return { engine: 'demo', reason: 'config.engine = demo' };
    }
    if (this.engineSetting === 'real') {
      return { engine: 'real', reason: 'config.engine = real' };
    }
    if (!fs.existsSync(this.pipelineScript)) {
      return { engine: 'demo', reason: 'pipeline/run_preview.py 不存在' };
    }
    if (!fs.existsSync(this.readyMarker)) {
      return { engine: 'demo', reason: 'pipeline/ready.json 尚未生成（真实管线未验收）' };
    }
    try {
      fs.accessSync(this.python, fs.constants.X_OK);
    } catch {
      return { engine: 'demo', reason: `解释器不可执行：${this.python}` };
    }
    return { engine: 'real', reason: 'pipeline/ready.json + 可用解释器' };
  }

  /** Demo clip path lookup: explicit override, then the asset repo reviews. */
  resolveDemoVideo() {
    if (this.demoVideoOverride && fs.existsSync(this.demoVideoOverride)) return this.demoVideoOverride;
    const candidates = [
      path.join(this.assetsRoot, 'reviews', 'marseille-v17-drag360', 'fullview.mp4'),
      path.join(this.assetsRoot, 'reviews', 'marseille-v17-drag360', 'preview.mp4'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  /** Shape sent to the browser list route (small, no raw metrics). */
  publicView(record) {
    return {
      id: record.id,
      status: record.status,
      params: record.params,
      warnings: record.warnings ?? [],
      engine: record.engine,
      engine_reason: record.engine_reason ?? null,
      call_id: record.call_id ?? null,
      session_id: record.session_id ?? null,
      created_at: record.created_at,
      updated_at: record.updated_at,
      started_at: record.started_at ?? null,
      finished_at: record.finished_at ?? null,
      elapsed_s: record.elapsed_s ?? null,
      video_url: record.video_url ?? null,
      video_path: record.video_path ?? null,
      metrics_summary: record.metrics_summary ?? null,
      error: record.error ?? null,
    };
  }

  /** Shape returned by the detail route (adds raw metrics + log tail). */
  detailView(record) {
    return {
      ...this.publicView(record),
      metrics: record.metrics ?? null,
      log_tail: record.status === 'error' ? readTail(path.join(this.tasksDir, record.id, 'run.log')) : null,
    };
  }

  /** Newest first, optionally capped. */
  list(limit = 50) {
    const all = [...this.tasks.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return all.slice(0, limit);
  }

  /**
   * Newest first, filtered by the owning Session (the conversation View shows
   * only the previews requested from its own session).
   */
  listForSession(sessionId, limit = 50) {
    if (!sessionId) return this.list(limit);
    return this.list(Number.MAX_SAFE_INTEGER)
      .filter((record) => record.session_id === sessionId)
      .slice(0, limit);
  }

  /** Distinct Session ids that have at least one task, newest session first. */
  sessions() {
    const seen = new Map();
    for (const record of this.list(Number.MAX_SAFE_INTEGER)) {
      if (!record.session_id || seen.has(record.session_id)) continue;
      seen.set(record.session_id, { session_id: record.session_id, tasks: 0, latest_at: record.created_at });
    }
    for (const record of this.tasks.values()) {
      const entry = record.session_id ? seen.get(record.session_id) : undefined;
      if (entry) entry.tasks += 1;
    }
    return [...seen.values()];
  }

  get(taskId) {
    const record = this.tasks.get(taskId);
    return record ? this.hydrate(record) : undefined;
  }

  /** Derive a compact metrics summary for lists and tool results. */
  summarizeMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return null;
    const geometry = metrics.geometry ?? {};
    return {
      frames: metrics.frames ?? null,
      fps: metrics.fps ?? null,
      duration_s: metrics.duration_s ?? null,
      motion_duration_s: metrics.motion_duration_s ?? null,
      geometry_ok: geometry.ok ?? null,
      degraded: geometry.degraded ?? null,
      degrade_reason: geometry.degrade_reason ?? null,
      effective_pattern: geometry.effective_pattern ?? null,
      min_joint_margin_deg: geometry.checks?.min_joint_margin_deg ?? null,
      self_penetrating_contacts: geometry.checks?.self_penetrating_contacts ?? null,
      warnings_count: Array.isArray(metrics.warnings) ? metrics.warnings.length : 0,
    };
  }

  /**
   * Register a task and start it (queued behind the current one).
   *
   * @param {Record<string, unknown>} params validated parameters.
   * @param {{warnings?: string[], callId?: string, sessionId?: string}} meta
   */
  create(params, meta = {}) {
    this.init();
    const id = newTaskId();
    const dir = path.join(this.tasksDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const { engine, reason } = this.resolveEngine();
    const record = this.hydrate({
      id,
      status: 'queued',
      params,
      warnings: meta.warnings ?? [],
      engine,
      engine_reason: reason,
      call_id: meta.callId ?? null,
      session_id: meta.sessionId ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      started_at: null,
      finished_at: null,
      elapsed_s: null,
      metrics: null,
      metrics_summary: null,
      error: null,
      exit_code: null,
    });
    this.tasks.set(id, record);
    if (record.session_id && fs.existsSync(path.join(this.pluginDir, 'rewards/catalog.json'))) {
      const recipe = loadSelection({ ...this.config, pluginDir: this.pluginDir, dataDir: path.dirname(this.tasksDir), python: this.python, assetsRoot: this.assetsRoot }, record.session_id, params.pattern, id);
      record.initial_reward_version = recipe.version;
    }
    this.persist(record);
    this.queue.push(record);
    this.pump();
    return record;
  }

  /** Start the next queued task when the runner is free. */
  pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = next;
    this.run(next)
      .catch((error) => this.fail(next, error))
      .finally(() => {
        this.running = null;
        this.pump();
      });
  }

  /** Resolve once the task settles (done/error), or after `timeoutMs`. */
  waitFor(record, timeoutMs) {
    if (record.status === 'done' || record.status === 'error') return Promise.resolve(record);
    return new Promise((resolve) => {
      const set = this.waiters.get(record.id) ?? new Set();
      this.waiters.set(record.id, set);
      const finish = () => {
        clearTimeout(timer);
        set.delete(finish);
        resolve(record);
      };
      const timer = setTimeout(finish, Math.max(1, timeoutMs));
      set.add(finish);
    });
  }

  /** Wake every waiter of one task. */
  settle(record) {
    record.updated_at = nowIso();
    record.elapsed_s = record.started_at
      ? Math.round((Date.now() - Date.parse(record.started_at)) / 100) / 10
      : record.elapsed_s ?? null;
    this.persist(record);
    const set = this.waiters.get(record.id);
    if (set) {
      this.waiters.delete(record.id);
      for (const wake of set) wake();
    }
  }

  /** Mark one task failed with a human-readable reason. */
  fail(record, error) {
    if (record.status === 'error' || record.status === 'done') return;
    record.status = 'error';
    record.finished_at = nowIso();
    record.error = error?.message ? String(error.message) : String(error);
    const tail = readTail(path.join(this.tasksDir, record.id, 'run.log'));
    if (tail) record.error = `${record.error}\n--- 管线日志尾部 ---\n${tail}`;
    this.settle(record);
    this.logger('task failed', record.id, record.error);
  }

  /** Write the params file, then copy the demo clip (or run the real pipeline). */
  async run(record) {
    const dir = path.join(this.tasksDir, record.id);
    record.status = 'running';
    record.started_at = nowIso();
    record.updated_at = nowIso();
    writeJsonAtomic(path.join(dir, 'params.json'), record.params);
    this.persist(record);
    if (record.engine === 'real') await this.runReal(record);
    else await this.runDemo(record);
    if (record.status === 'error') return;
    this.hydrate(record);
    record.finished_at = nowIso();
    record.status = 'done';
    this.settle(record);
  }

  /** Copy the sample clip and write a clearly-labelled demo metrics file. */
  async runDemo(record) {
    const dir = path.join(this.tasksDir, record.id);
    const clip = this.resolveDemoVideo();
    if (!clip) {
      throw new Error(
        `演示视频缺失（demo 引擎）：找不到 ${path.join(this.assetsRoot, 'reviews/marseille-v17-drag360/fullview.mp4')}。` +
        '请配置 demoVideo，或生成 pipeline/ready.json 启用真实管线。',
      );
    }
    await sleep(DEMO_RENDER_MS);
    fs.copyFileSync(clip, path.join(dir, 'preview.mp4'));
    const metrics = {
      schema_version: 1,
      engine: 'demo',
      params: record.params,
      frames: null,
      fps: null,
      duration_s: null,
      motion_duration_s: null,
      geometry: {
        ok: null,
        degraded: false,
        effective_pattern: null,
        degrade_reason: null,
        hard_error_count: null,
        checks: {},
      },
      warnings: [
        'DEMO 引擎：这不是按本次参数渲染的动作，只是预置示例片段。',
        `原因：${record.engine_reason}`,
      ],
      demo: { source_clip: clip },
      created_at: nowIso(),
    };
    writeJsonAtomic(path.join(dir, 'metrics.json'), metrics);
    record.metrics = metrics;
    record.metrics_summary = this.summarizeMetrics(metrics);
  }

  /** Spawn `pipeline/run_preview.py` and wait for it to finish. */
  async runReal(record) {
    const dir = path.join(this.tasksDir, record.id);
    const logPath = path.join(dir, 'run.log');
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      MPLCONFIGDIR: path.join(dir, '.mpl'),
      MICRODUCK_ASSET_ROOT: this.assetsRoot,
      MICRODUCK_PYTHON: this.python,
      PYTHONPATH: [path.join(this.assetsRoot, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    };
    const args = [this.pipelineScript, '--params-json', path.join(dir, 'params.json'), '--out-dir', dir];
    this.logger('running pipeline', record.id, this.python, args.join(' '));

    const child = spawn(this.python, args, { cwd: this.pluginDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    record._child = child;
    child.stdout.on('data', (chunk) => log.write(chunk));
    child.stderr.on('data', (chunk) => log.write(chunk));

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        log.end();
        if (signal) resolve(128);
        else resolve(code ?? 1);
      });
    }).catch((error) => {
      log.end();
      throw new Error(`无法启动 Python 管线：${error?.message ?? error}。检查 config.python 指向的解释器。`);
    });
    record._child = null;
    record.exit_code = exitCode;

    if (exitCode !== 0) {
      const tail = readTail(logPath);
      const lastLine = tail.split('\n').filter((line) => line.trim()).pop() ?? '';
      throw new Error(`preview 管线失败（exit ${exitCode}）：${lastLine || '详见 run.log'}`);
    }
    const metricsPath = path.join(dir, 'metrics.json');
    const videoPath = path.join(dir, 'preview.mp4');
    if (!fs.existsSync(videoPath)) throw new Error('管线退出码为 0，但没有生成 preview.mp4。');
    if (!fs.existsSync(metricsPath)) throw new Error('管线退出码为 0，但没有生成 metrics.json。');
    let metrics = null;
    try {
      metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    } catch (error) {
      throw new Error(`metrics.json 无法解析：${error?.message ?? error}`);
    }
    record.metrics = metrics;
    record.metrics_summary = this.summarizeMetrics(metrics);
    record.video_path = videoPath;
  }

  /** Stop one task (used when the calling tool is aborted). */
  cancel(record, reason = '调用被取消') {
    const child = record._child;
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000).unref?.();
      } catch { /* already gone */ }
    }
    if (record.status === 'queued') this.queue = this.queue.filter((queued) => queued !== record);
    if (record.status !== 'done' && record.status !== 'error') {
      record.status = 'error';
      record.error = reason;
      record.finished_at = nowIso();
      this.settle(record);
    }
  }

  /** Shut the runner down (plugin unload). */
  dispose() {
    if (this.running) this.cancel(this.running, '插件卸载，渲染中断');
    for (const record of [...this.queue]) this.cancel(record, '插件卸载，渲染中断');
    this.queue = [];
  }
}
