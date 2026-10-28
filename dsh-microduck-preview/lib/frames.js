/**
 * Live MuJoCo frame service for the interactive viewer.
 *
 * Instead of playing a pre-encoded mp4, the viewer asks the Host for the exact
 * frame it needs (time + free-camera pose). One long-lived Python child process
 * per task keeps the MjModel/MjData/Renderer warm, so a 900x600 JPEG costs
 * ~13 ms (measured: 11 ms render + 1-2 ms encode) — fast enough to orbit the
 * camera and scrub time interactively.
 *
 * Protocol (one JSON line per message, stdout only):
 *   ready:    {"ready":true,"duration_s":..,"fps":..,"frames":..,...}
 *   request:  {"id":7,"t":1.23,"az":130,"el":-18,"dist":0.5,"follow":true,...}
 *   response: {"id":7,"ok":true,"file":"<task>/.frames/7.jpg","bytes":26000,"ms":13}
 *
 * The worker writes the JPEG and we read+unlink it here; JSON lines stay small.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FRAME_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 20_000;

/** One python frame_server.py process bound to one task directory. */
class FrameWorker {
  constructor(options) {
    this.taskDir = options.taskDir;
    this.python = options.python;
    this.assetRoot = options.assetRoot;
    this.pluginDir = options.pluginDir;
    this.logger = options.logger ?? (() => {});
    this.child = null;
    this.ready = null;
    this.dead = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.lastUsed = Date.now();
    this.readyInfo = null;
    this.stderrTail = '';
  }

  /** Spawn the process and resolve once the worker reports ready. */
  start() {
    if (this.ready) return this.ready;
    const script = path.join(this.pluginDir, 'pipeline', 'frame_server.py');
    if (!fs.existsSync(script)) throw new Error(`frame_server.py 缺失：${script}`);
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      MPLCONFIGDIR: path.join(this.taskDir, '.frames-mpl'),
      MICRODUCK_ASSET_ROOT: this.assetRoot,
      MICRODUCK_PYTHON: this.python,
      PYTHONPATH: [path.join(this.assetRoot, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    };
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.python, [script, '--task-dir', this.taskDir, '--asset-root', this.assetRoot], {
        cwd: this.pluginDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const timer = setTimeout(() => {
        reject(new Error(`frame_server 启动超时（${READY_TIMEOUT_MS} ms）`));
        this.kill('startup timeout');
      }, READY_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => this.onStdout(chunk));
      child.stderr.on('data', (chunk) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        this.markDead(`无法启动 frame_server：${error?.message ?? error}`);
        reject(new Error(`无法启动 frame_server：${error?.message ?? error}`));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        this.markDead(`frame_server 退出（code=${code} signal=${signal}）`);
        if (!this.readyInfo) reject(new Error(`frame_server 退出（code=${code}）${this.stderrTail.slice(-300)}`));
      });

      this.onReady = (info) => {
        clearTimeout(timer);
        this.readyInfo = info;
        resolve(info);
      };
      this.onReadyError = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    return this.ready;
  }

  /** Split stdout into JSON lines and dispatch responses. */
  onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger('frame_server non-JSON stdout:', line.slice(0, 200));
      return;
    }
    if (message.ready !== undefined) {
      if (message.ready) {
        this.onReady?.(message);
      } else {
        this.markDead(`frame_server 启动失败：${message.error ?? 'unknown'}`, message.error);
        this.onReadyError?.(new Error(message.error ?? 'frame_server not ready'));
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message);
    else entry.reject(new Error(message.error ?? 'frame render failed'));
  }

  markDead(reason, error) {
    if (this.dead) return;
    this.dead = true;
    this.logger('frame worker dead:', reason);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(error ?? reason));
    }
    this.pending.clear();
  }

  /** Render one frame; resolves with the JPEG bytes and timing. */
  async render(params) {
    await this.start();
    if (this.dead) throw new Error('frame_server 已退出');
    this.lastUsed = Date.now();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, ...params });
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`单帧渲染超时（${FRAME_TIMEOUT_MS} ms）`));
      }, FRAME_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    this.lastUsed = Date.now();
    const bytes = fs.readFileSync(response.file);
    try { fs.unlinkSync(response.file); } catch { /* worker reuses names */ }
    return { buffer: bytes, ms: response.ms, bytes: bytes.length };
  }

  /** Terminate the process and fail pending work. */
  kill(reason = 'idle') {
    this.markDead(reason);
    if (this.child && !this.child.killed) {
      try { this.child.stdin.end(); } catch { /* already closed */ }
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
      const child = this.child;
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000).unref?.();
    }
    this.child = null;
  }
}

/**
 * Pool of warm frame workers, at most one per task directory.
 *
 * `render(taskId, taskDir, params)` spawns on first use, reuses while warm and
 * kills idle workers so a long DSH session does not keep N MuJoCo processes.
 */
export class FramePool {
  constructor(options = {}) {
    this.python = options.python;
    this.assetRoot = options.assetRoot;
    this.pluginDir = options.pluginDir;
    this.logger = options.logger ?? (() => {});
    this.maxWorkers = options.maxWorkers ?? 2;
    this.idleMs = options.idleMs ?? 120_000;
    /** @type {Map<string, FrameWorker>} */
    this.workers = new Map();
    this.sweeper = setInterval(() => this.sweep(), Math.min(30_000, this.idleMs)).unref?.();
  }

  /** Kill workers whose last request is older than the idle window. */
  sweep() {
    const now = Date.now();
    for (const [taskId, worker] of this.workers) {
      if (worker.pending.size === 0 && now - worker.lastUsed > this.idleMs) {
        worker.kill('idle');
        this.workers.delete(taskId);
      }
    }
  }

  /** Render one frame for a task, spawning or evicting workers as needed. */
  async render(taskId, taskDir, params) {
    let worker = this.workers.get(taskId);
    if (worker && worker.dead) {
      this.workers.delete(taskId);
      worker = null;
    }
    if (!worker) {
      if (this.workers.size >= this.maxWorkers) {
        // Evict the least recently used idle worker.
        const victim = [...this.workers.entries()]
          .filter(([, candidate]) => candidate.pending.size === 0)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (victim) {
          victim[1].kill('evicted');
          this.workers.delete(victim[0]);
        }
      }
      worker = new FrameWorker({
        taskDir,
        python: this.python,
        assetRoot: this.assetRoot,
        pluginDir: this.pluginDir,
        logger: this.logger,
      });
      this.workers.set(taskId, worker);
    }
    return worker.render(params);
  }

  /** Ready metadata of a warm worker (spawns nothing). */
  info(taskId) {
    const worker = this.workers.get(taskId);
    return worker?.readyInfo ?? null;
  }

  /**
   * Drop one task's worker (the viewer closed or switched task).
   *
   * A worker holds a compiled MuJoCo model plus a GL renderer (~800 MB), so the
   * browser tells us when nobody is looking any more instead of waiting for the
   * idle sweep.
   */
  release(taskId) {
    const worker = this.workers.get(taskId);
    if (!worker) return false;
    worker.kill('released by client');
    this.workers.delete(taskId);
    return true;
  }

  /** Stop every worker (plugin unload). */
  dispose() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const [, worker] of this.workers) worker.kill('pool dispose');
    this.workers.clear();
  }
}
