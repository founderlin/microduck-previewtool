import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.mjs';
import { doctor } from '../lib/config.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.dirname(skillRoot);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'microduck-service-tests-'));
const clip = path.join(temporary, 'fixture.mp4');
const bytes = Buffer.alloc(8192, 7);
fs.writeFileSync(clip, bytes);
const configuration = (name = 'main') => ({
  projectRoot, skillRoot, pluginDir: path.join(projectRoot, 'dsh-microduck-preview'),
  dataDir: path.join(temporary, name), python: '/missing/microduck-python',
  assetsRoot: path.join(temporary, 'no-model-assets'), host: '127.0.0.1', port: 0,
  engine: 'demo', demoVideo: clip, idleMs: 100,
});
let service;
let firstTask, supersededTask, secondSessionTask;
const sessionQuery = (id = 'chat-A') => `session_id=${encodeURIComponent(id)}`;
async function request(route, { method = 'GET', data, headers = {} } = {}) {
  const response = await fetch(service.origin + '/api/microduck' + route, {
    method,
    headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(data !== undefined ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  return { response, result };
}
const preview = (owner, params, extra = {}) => request('/preview', { method: 'POST', data: { session_id: owner, params, ...extra } });
const taskId = (record) => record.task_id ?? record.id;
async function waitFor(id, owner = 'chat-A') {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await request(`/tasks/${id}?${sessionQuery(owner)}`);
    if (['done', 'error'].includes(result.result.status)) return result.result;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Task ${id} did not settle within 10 seconds`);
}

before(async () => { service = await startServer(configuration()); });
after(async () => { await service?.close(); fs.rmSync(temporary, { recursive: true, force: true }); });

describe('local preview service', () => {
  it('binds loopback, records its instance, and reports the project without requiring a session', async () => {
    assert.equal(service.server.address().address, '127.0.0.1');
    const { response, result } = await request('/health');
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.projectRoot, projectRoot);
    assert.equal(result.inline_ui, false);
    assert.equal(result.viewer_mode, 'codex-browser-panel');
    const registry = JSON.parse(fs.readFileSync(path.join(configuration().dataDir, 'service.json')));
    assert.equal(registry.origin, service.origin);
    assert.equal(registry.instance_id, result.instance_id);
    assert.equal(registry.pid, process.pid);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  });

  it('checks missing dependencies without spawning a missing interpreter', async () => {
    const report = await doctor(configuration());
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === 'python').ok, false);
    assert.equal(report.checks.find((check) => check.name === 'robot_xml').ok, false);
    assert.equal(report.checks.find((check) => check.name === 'lib/spec.js').ok, true);
  });

  it('requires explicit session identifiers and rejects cross-origin, cross-site, and forged Host requests', async () => {
    assert.equal((await request('/tasks')).response.status, 400);
    assert.equal((await request('/presets?session_id=bad%20session')).response.status, 400);
    assert.equal((await preview('', {})).response.status, 400);
    assert.equal((await request('/health', { headers: { origin: 'https://untrusted.example' } })).response.status, 403);
    assert.equal((await request('/health', { headers: { 'sec-fetch-site': 'cross-site' } })).response.status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => {
      http.get(service.origin + '/api/microduck/health', { headers: { host: 'untrusted.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(forgedHostStatus, 403);
  });

  it('validates request bodies and parameters before creating any tasks', async () => {
    for (const data of ['{', '[]', 'null']) {
      assert.equal((await request('/preview', { method: 'POST', data })).response.status, 400);
    }
    assert.equal((await request('/preview', { method: 'POST', headers: { 'content-type': 'text/plain' }, data: '{}' })).response.status, 415);
    assert.equal((await request('/preview', { method: 'POST', data: { session_id: 'chat-A' } })).response.status, 400);
    const invalid = await preview('chat-A', { step_length_m: 0.2 });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.result.error, /0\.02/);
    assert.equal((await preview('chat-A', { unknown: 1 })).response.status, 400);
    assert.equal((await preview('chat-A', {}, { wait_ms: 25_001 })).response.status, 400);
    assert.equal((await preview('chat-A', {}, { wait_ms: -1 })).response.status, 400);
    assert.equal((await preview('chat-A', {}, { wait_ms: '100' })).response.status, 400);
    const oversized = await request('/preview', { method: 'POST', data: { session_id: 'chat-A', params: {}, padding: 'x'.repeat(40_000) } });
    assert.equal(oversized.response.status, 413);
    assert.equal((await request(`/tasks?${sessionQuery()}`)).result.tasks.length, 0);
  });

  it('returns a stable task ID immediately and explicitly labels demo output', async () => {
    const started = await preview('chat-A', { pattern: 'figure8', direction: 'backward', step_length_m: 0.025, radius_m: 0.10 });
    assert.equal(started.response.status, 200);
    assert.ok(['running', 'queued'].includes(started.result.status));
    firstTask = taskId(started.result);
    assert.ok(firstTask);
    assert.equal(started.result.engine, 'demo');
    const viewer = new URL(started.result.viewer_url);
    assert.equal(viewer.origin, service.origin);
    assert.equal(viewer.searchParams.get('session_id'), 'chat-A');
    assert.equal(viewer.searchParams.get('task_id'), firstTask);
    const done = await waitFor(firstTask);
    assert.equal(done.status, 'done');
    assert.equal(done.ok, true);
    assert.equal(done.metrics.engine, 'demo');
    assert.ok(done.warnings.some((warning) => /DEMO/.test(warning)));
    assert.equal(done.metrics_summary.geometry_ok, null);
  });

  it('never inherits another conversation’s parameters and rejects foreign base tasks', async () => {
    const other = await preview('chat-B', { radius_m: 0.08 }, { wait_ms: 5_000 });
    assert.equal(other.response.status, 200);
    secondSessionTask = taskId(other.result);
    assert.equal(other.result.params.pattern, 'line');
    assert.equal(other.result.params.direction, 'forward');
    assert.equal(other.result.params.step_length_m, 0.04);
    const tweak = await preview('chat-A', { radius_m: 0.12 }, { wait_ms: 5_000 });
    assert.equal(tweak.response.status, 200);
    assert.equal(tweak.result.params.pattern, 'figure8');
    assert.equal(tweak.result.params.direction, 'backward');
    assert.equal(tweak.result.params.step_length_m, 0.025);
    assert.equal(tweak.result.params.radius_m, 0.12);
    const foreign = await preview('chat-B', { laps: 2 }, { base_task_id: firstTask });
    assert.equal(foreign.response.status, 404);
    assert.equal((await request(`/tasks/${firstTask}?${sessionQuery('chat-B')}`)).response.status, 404);
    const history = (await request(`/tasks?${sessionQuery('chat-B')}`)).result.tasks;
    assert.deepEqual(history.map(taskId), [secondSessionTask]);
    const presets = (await request(`/presets?${sessionQuery('chat-B')}`)).result;
    assert.equal(presets.templates.length, 5);
    assert.equal(presets.recent_tasks.length, 1);
    assert.equal(presets.last_params.pattern, 'line');
    assert.equal(presets.parameter_schema.step_length_m.minimum, 0.02);
    supersededTask = firstTask;
    firstTask = taskId(tweak.result);
  });

  it('does not retain a superseded action as an older baseline', async () => {
    const result = await preview('chat-A', { laps: 0.5 }, { base_task_id: supersededTask, wait_ms: 5_000 });
    assert.equal(result.response.status, 404);
    assert.deepEqual((await request(`/tasks?${sessionQuery()}`)).result.tasks.map(taskId), [firstTask]);
  });

  it('serves exact video byte ranges and refuses demo interactive frames', async () => {
    const video = `/tasks/${firstTask}/video?${sessionQuery()}`;
    const full = await fetch(service.origin + '/api/microduck' + video);
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const partial = await fetch(service.origin + '/api/microduck' + video, { headers: { range: 'bytes=10-29' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 10-29/${bytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(10, 30));
    const suffix = await fetch(service.origin + '/api/microduck' + video, { headers: { range: 'bytes=-12' } });
    assert.equal(suffix.status, 206);
    assert.equal((await suffix.arrayBuffer()).byteLength, 12);
    const invalid = await fetch(service.origin + '/api/microduck' + video, { headers: { range: 'bytes=9000-' } });
    assert.equal(invalid.status, 416);
    const head = await fetch(service.origin + '/api/microduck' + video, { method: 'HEAD', headers: { range: 'bytes=0-99' } });
    assert.equal(head.status, 206);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const scene = await request(`/tasks/${firstTask}/scene?${sessionQuery()}`);
    assert.equal(scene.result.interactive, false);
    assert.match(scene.result.reason, /DEMO/);
    const frame = await request(`/tasks/${firstTask}/frame?${sessionQuery()}`);
    assert.equal(frame.response.status, 409);
  });

  it('rejects malformed and traversal routes instead of exposing files or throwing 500s', async () => {
    for (const route of [
      '/tasks/%2e%2e%2fpackage.json?session_id=chat-A',
      '/tasks/%5cetc?session_id=chat-A',
      '/tasks/%00?session_id=chat-A',
      '/tasks/%ZZ?session_id=chat-A',
      '/tasks/missing?session_id=chat-A',
    ]) {
      const { response } = await request(route);
      assert.ok([400, 404].includes(response.status), `${route}: ${response.status}`);
    }
    const postRelease = await request(`/viewer/release?task_id=${firstTask}&${sessionQuery()}`, { method: 'POST' });
    assert.equal(postRelease.response.status, 200);
    assert.equal(postRelease.result.released, false);
    assert.equal((await request(`/viewer/release?task_id=${firstTask}&${sessionQuery('chat-B')}`, { method: 'POST' })).response.status, 404);
  });

  it('persists completed tasks, marks interrupted records on restart, and cleans its registry on close', async () => {
    await service.close();
    const registry = path.join(configuration().dataDir, 'service.json');
    assert.equal(fs.existsSync(registry), false);
    const interrupted = '20261028-000000-interrupted';
    const dir = path.join(configuration().dataDir, 'tasks', interrupted);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
      id: interrupted, session_id: 'chat-A', status: 'running', engine: 'demo',
      params: { pattern: 'line' }, created_at: '2026-10-28T00:00:00Z',
    }));
    service = await startServer(configuration());
    const restored = await request(`/tasks/${firstTask}?${sessionQuery()}`);
    assert.equal(restored.result.status, 'done');
    const failed = await request(`/tasks/${interrupted}?${sessionQuery()}`);
    assert.equal(failed.result.status, 'error');
    assert.match(failed.result.error, /中断/);
  });
});

describe('failure and shutdown boundaries', () => {
  it('returns a dependency error without creating a real task when Python or model assets are absent', async () => {
    const isolated = await startServer({ ...configuration('missing-real'), engine: 'real' });
    try {
      const post = async (params) => {
        const response = await fetch(isolated.origin + '/api/microduck/preview', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: 'missing-real-session', params }),
        });
        return { status: response.status, result: await response.json() };
      };
      assert.equal((await post({ step_length_m: 0.2 })).status, 400);
      const valid = await post({});
      assert.equal(valid.status, 503);
      assert.match(valid.result.error, /依赖检查失败/);
      const response = await fetch(isolated.origin + '/api/microduck/tasks?session_id=missing-real-session');
      assert.equal((await response.json()).tasks.length, 0);
    } finally { await isolated.close(); }
  });

  it('queues a second render, cancels both states on shutdown, and never marks them done later', async () => {
    const config = configuration('shutdown-queue');
    const isolated = await startServer(config);
    let records;
    try {
      const submit = async () => {
        const response = await fetch(isolated.origin + '/api/microduck/preview', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: 'shutdown-session', params: {} }),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const running = await submit();
      const queued = await submit();
      assert.equal(running.status, 'running');
      assert.equal(queued.status, 'queued');
      records = [taskId(running), taskId(queued)];
      const health = await (await fetch(isolated.origin + '/api/microduck/health')).json();
      const wrongInstance = await fetch(isolated.origin + '/api/microduck/shutdown', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: 'incorrect-instance' }),
      });
      assert.equal(wrongInstance.status, 409);
      const stopped = await fetch(isolated.origin + '/api/microduck/shutdown', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instance_id: health.instance_id }),
      });
      assert.equal(stopped.status, 200);
      assert.equal((await stopped.json()).ok, true);
    } finally { await isolated.close(); }
    assert.equal(fs.existsSync(path.join(config.dataDir, 'service.json')), false);
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    for (const id of records) {
      const record = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'tasks', id, 'task.json')));
      assert.equal(record.status, 'error');
      assert.match(record.error, /中断|替代/);
      assert.equal('_child' in record, false);
    }
    const restored = await startServer(config);
    try {
      const response = await fetch(restored.origin + '/api/microduck/tasks?session_id=shutdown-session');
      const history = (await response.json()).tasks;
      assert.equal(history.length, 2);
      assert.ok(history.every((record) => record.status === 'error'));
    } finally { await restored.close(); }
  });
});
