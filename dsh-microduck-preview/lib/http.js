/**
 * The plugin's `/api/microduck/*` HTTP surface.
 *
 * The routes are registered as a `prefix` route on `ctx.webServer` at
 * `/api/microduck`. Because a longer prefix wins the web server's route match,
 * this handler re-applies the Connection trust/auth fence itself
 * (`ctx.connection.requestRejection`) before serving anything — Trusted-Origin
 * (DNS-rebinding/cross-site) check plus the signed browser cookie.
 *
 * `createApiHandler` is dependency-injected and returns a plain Node
 * `(req, res)` handler so it can be exercised by a unit test without DSH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createWorkbench } from './workbench.js';
import { workbenchConfig } from './runtime.js';

/** Shared channel prefix these routes answer under. */
export const API_PREFIX = '/api/microduck';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** Write a JSON body and end the response. */
function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Parse an RFC 7233 single-range header against a known file size. */
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { invalid: true };
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end };
}

/** Stream an mp4 file with RFC 7233 range support (206/416/200). */
export function serveVideo(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: 'video_not_found', message: '任务视频不存在（可能已被清理）。' });
    return;
  }
  if (!stat.isFile() || stat.size === 0) {
    sendJson(res, 404, { error: 'video_not_found', message: '任务视频文件为空或不是普通文件。' });
    return;
  }

  const headers = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=60',
    'last-modified': stat.mtime.toUTCString(),
  };

  const range = parseRange(req.headers.range, stat.size);
  if (range?.invalid) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
    res.end();
    return;
  }

  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    pipeFile(req, res, filePath, undefined);
    return;
  }

  const length = range.end - range.start + 1;
  res.writeHead(206, {
    ...headers,
    'content-length': length,
    'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
  });
  if (req.method === 'HEAD') { res.end(); return; }
  pipeFile(req, res, filePath, range);
}

/** Pipe a slice of a file, cleaning up the stream on abort. */
function pipeFile(req, res, filePath, range) {
  const stream = fs.createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined);
  stream.on('error', (error) => {
    if (!res.writableEnded) {
      try { res.destroy(error); } catch { /* already closed */ }
    }
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * Build the prefix-route handler.
 *
 * @param {{
 *   store: import('./tasks.js').PreviewStore,
 *   templates: () => Record<string, unknown>,
 *   apiPrefix?: string,
 *   guard?: (headers: unknown) => number | undefined,
 *   logger?: (...args: unknown[]) => void,
 * }} options
 */
export function createApiHandler(options) {
  const { store, templates, guard, logger = () => {} } = options;
  const apiPrefix = options.apiPrefix ?? API_PREFIX;
  const workbench = createWorkbench({ config: workbenchConfig(store), store, send: sendJson, serveVideo, frames: options.frames });

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { sendJson(res, 400, { error: 'invalid_path' }); return; }
    if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) { sendJson(res, 404, { error: 'not_found' }); return; }

    if (!pathname.startsWith(apiPrefix)) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    // Re-apply Connection's Host/Origin + browser-cookie fence for this route.
    if (guard) {
      let rejection;
      try {
        rejection = guard(req.headers);
      } catch (error) {
        logger('guard threw', error?.message ?? error);
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
      if (rejection) {
        sendJson(res, rejection, {
          error: rejection === 401 ? 'unauthorized' : 'forbidden',
          message: '请求未通过 DSH 的浏览器认证；请从 DSH Web 页面访问。',
        });
        return;
      }
    }

    const suffix = pathname.slice(apiPrefix.length) || '/';
    const parts = suffix.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    try {
      if (await workbench(req, res, url)) return;
      if ((method === 'GET' || method === 'HEAD') && parts.length === 1 && parts[0] === 'health') {
        const engine = store.resolveEngine();
        sendJson(res, 200, {
          ok: true,
          engine: engine.engine,
          engine_reason: engine.reason,
          pipeline_ready: engine.engine === 'real',
          tasks: store.tasks.size,
        });
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && parts.length === 0) {
        const engine = store.resolveEngine();
        sendJson(res, 200, {
          tasks: store.list(100).map((record) => store.publicView(record)),
          engine: engine.engine,
          engine_reason: engine.reason,
          pipeline_ready: engine.engine === 'real',
          server_time: new Date().toISOString(),
        });
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && parts.length === 1 && parts[0] === 'tasks') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
        // The conversation View scopes its list to its own Session; omitting the
        // parameter keeps the global list (panel debugging / other consumers).
        const sessionId = url.searchParams.get('session_id');
        const records = sessionId ? store.listForSession(sessionId, limit) : store.list(limit);
        const engine = store.resolveEngine();
        sendJson(res, 200, {
          tasks: records.map((record) => store.publicView(record)),
          session_id: sessionId ?? null,
          total_all_sessions: store.tasks.size,
          engine: engine.engine,
          engine_reason: engine.reason,
          pipeline_ready: engine.engine === 'real',
          server_time: new Date().toISOString(),
        });
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && parts.length === 1 && parts[0] === 'sessions') {
        sendJson(res, 200, { sessions: store.sessions() });
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && parts.length === 1 && parts[0] === 'presets') {
        sendJson(res, 200, templates());
        return;
      }

      // The viewer tells us when nobody is looking so the ~800 MB MuJoCo worker
      // can go away immediately instead of waiting for the idle sweep.
      if ((method === 'POST' || method === 'GET') && parts.length === 2
        && parts[0] === 'viewer' && parts[1] === 'release') {
        const taskId = url.searchParams.get('task_id') ?? '';
        const released = taskId && options.frames ? options.frames.release(taskId) : false;
        sendJson(res, 200, { released: Boolean(released), task_id: taskId || null });
        return;
      }

      if (parts[0] === 'tasks' && parts.length >= 2) {
        const taskId = parts[1];
        const record = store.get(taskId);
        if (!record) {
          sendJson(res, 404, { error: 'task_not_found', message: `没有找到任务 ${taskId}。` });
          return;
        }
        if (parts.length === 2 && (method === 'GET' || method === 'HEAD')) {
          sendJson(res, 200, store.detailView(record));
          return;
        }
        if (parts.length === 3 && parts[2] === 'video' && (method === 'GET' || method === 'HEAD')) {
          if (!record.video_path) {
            sendJson(res, 409, {
              error: 'video_not_ready',
              message: record.status === 'error' ? (record.error ?? '渲染失败') : '视频还在渲染中。',
            });
            return;
          }
          serveVideo(req, res, path.resolve(record.video_path));
          return;
        }
        if (parts.length === 3 && parts[2] === 'metrics' && (method === 'GET' || method === 'HEAD')) {
          if (!record.metrics) {
            sendJson(res, 404, { error: 'metrics_not_ready', message: '还没有 metrics。' });
            return;
          }
          sendJson(res, 200, record.metrics);
          return;
        }
        if (parts.length === 3 && parts[2] === 'scene' && (method === 'GET' || method === 'HEAD')) {
          // Metadata the interactive viewer needs before it asks for frames.
          const metrics = record.metrics ?? {};
          const motionPath = path.join(store.tasksDir, record.id, 'motion.json');
          sendJson(res, 200, {
            task_id: record.id,
            status: record.status,
            interactive: fs.existsSync(motionPath),
            engine: record.engine,
            duration_s: metrics.motion_duration_s ?? metrics.duration_s ?? null,
            fps: metrics.fps ?? null,
            frames: metrics.frames ?? null,
            params: record.params,
            geometry: metrics.geometry ?? null,
            default_camera: { az: 130, el: -18, dist: 0.52, follow: true },
            video_url: record.video_url ?? null,
          });
          return;
        }
        if (parts.length === 3 && parts[2] === 'frame' && (method === 'GET' || method === 'HEAD')) {
          if (!options.frames) {
            sendJson(res, 503, { error: 'viewer_unavailable', message: '帧服务未启用。' });
            return;
          }
          if (record.status !== 'done') {
            sendJson(res, 409, { error: 'not_ready', message: '任务还没完成，无法交互渲染。' });
            return;
          }
          const taskDir = path.join(store.tasksDir, record.id);
          if (!fs.existsSync(path.join(taskDir, 'motion.json'))) {
            sendJson(res, 409, {
              error: 'no_motion',
              message: record.engine === 'demo'
                ? '这是 DEMO 任务，没有 motion 数据，无法交互渲染；请用真实管线重跑。'
                : '任务目录缺少 motion.json，无法交互渲染。',
            });
            return;
          }
          const q = url.searchParams;
          const num = (name, fallback, low, high) => {
            const value = Number(q.get(name));
            if (!Number.isFinite(value)) return fallback;
            return Math.min(high, Math.max(low, value));
          };
          const duration = Number(record.metrics?.motion_duration_s ?? record.metrics?.duration_s ?? 15);
          const params = {
            t: num('t', 0, 0, Math.max(0.05, duration)),
            az: num('az', 130, -720, 720),
            el: num('el', -18, -89, 30),
            dist: num('dist', 0.52, 0.12, 2.4),
            follow: q.get('follow') !== '0',
            lookat: [num('lx', 0, -2, 2), num('ly', 0, -2, 2)],
            w: Math.round(num('w', 900, 320, 1280)),
            h: Math.round(num('h', 600, 240, 800)),
            shadows: q.get('shadows') !== '0',
            quality: Math.round(num('q', 85, 50, 95)),
          };
          let frame;
          try {
            frame = await options.frames.render(record.id, taskDir, params);
          } catch (error) {
            logger('frame render failed', error?.message ?? error);
            sendJson(res, error.status ?? 400, { error: 'frame_failed', message: String(error?.message ?? error) });
            return;
          }
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'content-length': frame.bytes,
            'cache-control': 'no-store',
            'x-mujoco-ms': String(frame.ms ?? ''),
            'x-mujoco-bytes': String(frame.bytes ?? ''),
          });
          res.end(frame.buffer);
          return;
        }
      }

      sendJson(res, 404, { error: 'not_found', path: pathname });
    } catch (error) {
      logger('api handler failed', error?.stack ?? error);
      sendJson(res, error.status ?? 400, { error: 'internal_error', message: String(error?.message ?? error) });
    }
  };
}
