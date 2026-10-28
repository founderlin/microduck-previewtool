/**
 * Dependency-free checks for the Host half: parameter validation, the demo task
 * runner, and the `/api/microduck/*` routes over a real node:http listener.
 *
 * Run with:  node test/host.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plugin from '../index.js';
import { createApiHandler } from '../lib/http.js';
import { buildTemplates, inheritParams, summarizeParams, validateInput } from '../lib/spec.js';
import { PreviewStore } from '../lib/tasks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '.tmp');
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });

let passed = 0;
const test = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
};

// ---------------------------------------------------------------- spec ----
await test('module exposes named exports only', () => {
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['tools', 'webServer']);
  assert.equal(plugin.name, 'microduck-preview');
  assert.equal(plugin.default, undefined);
});

await test('a one-field tweak inherits the previous task params', () => {
  const previous = { pattern: 'arc', direction: 'backward', step_length_m: 0.03, radius_m: 0.09, laps: 1, speed: 'normal' };
  // "圈再大一点": only radius_m passed -> the arc/backward context must survive.
  const tweak = inheritParams({ radius_m: 0.12 }, previous);
  assert.deepEqual(tweak.inherited.sort(), ['direction', 'laps', 'pattern', 'speed', 'step_length_m']);
  const { params } = validateInput(tweak.merged);
  assert.equal(params.pattern, 'arc');
  assert.equal(params.direction, 'backward');
  assert.equal(params.radius_m, 0.12);
  assert.equal(params.step_length_m, 0.03);

  // Explicit values win over the previous task. Unrelated fields are not inherited.
  const explicit = inheritParams({ pattern: 'line', direction: 'forward' }, previous);
  assert.equal(explicit.merged.pattern, 'line');
  assert.equal(explicit.merged.direction, 'forward');
  assert.equal(explicit.merged.radius_m, undefined);

  const hoverAfterComposite = inheritParams(
    { pattern: 'hover' },
    { pattern: 'composite', direction: 'forward', step_length_m: 0.04, speed: 'normal',
      segments: [{ kind: 'straight', length_m: 0.35 }] },
  );
  assert.equal(hoverAfterComposite.merged.pattern, 'hover');
  assert.equal(hoverAfterComposite.merged.segments, undefined);
  assert.equal(hoverAfterComposite.merged.speed, 'normal');

  // No previous task -> plain defaults, no inheritance.
  const first = inheritParams({ direction: 'backward' }, null);
  assert.deepEqual(first.inherited, []);
  assert.equal(validateInput(first.merged).params.pattern, 'line');
});

await test('validates defaults, ranges, unknown keys and Chinese synonyms', () => {
  const defaults = validateInput({});
  assert.deepEqual(defaults.params, {
    pattern: 'line', direction: 'forward', step_length_m: 0.04,
    radius_m: 0.09, laps: 1, speed: 'normal',
  });

  const zh = validateInput({ pattern: '8字', direction: '倒退', speed: '慢' });
  assert.equal(zh.params.pattern, 'figure8');
  assert.equal(zh.params.direction, 'backward');
  assert.equal(zh.params.speed, 'slow');

  assert.throws(() => validateInput({ step_length_m: 0.2 }), /超出允许范围 0\.02–0\.06 m/);
  assert.throws(() => validateInput({ pattern: 'spiral' }), /不是合法取值/);
  assert.throws(() => validateInput({ bogus: 1 }), /无法识别的参数/);
  assert.throws(() => validateInput({ laps: 'many' }), /必须是数字/);

  assert.equal(summarizeParams(validateInput({ direction: 'backward', pattern: 'figure8' }).params),
    '倒退走8 字 · 步长 0.040 m · 半径 0.090 m · 圈数 1 · 常速');
});

await test('composite segments validate, default to forward/left/right, and summarise', () => {
  const dflt = validateInput({ pattern: 'composite' });
  assert.equal(dflt.params.pattern, 'composite');
  assert.equal(dflt.params.segments.length, 3);
  assert.deepEqual(dflt.params.segments[1], { kind: 'turn', turn_deg: 90, radius_m: 0.12 });
  assert.match(summarizeParams(dflt.params), /直行 0\.350 m → 左转 90° \(R0\.120\) → 右转 90° \(R0\.120\)/);

  const explicit = validateInput({ pattern: 'composite', segments: [
    { kind: 'straight', length_m: 0.3 },
    { kind: 'left', turn_deg: 120, radius_m: 0.1 },
  ] });
  assert.equal(explicit.params.segments[1].turn_deg, 120);
  assert.match(summarizeParams(explicit.params), /左转 120°/);

  assert.throws(() => validateInput({ pattern: 'composite', segments: [{ kind: 'turn', turn_deg: 90, radius_m: 0.03 }] }), /radius_m=0\.03/);
  const timeline = validateInput({ pattern: 'composite', segments: [
    { kind: 'turn', turn_deg: 90, radius_m: 0.12 },
    { kind: 'straight', length_m: 0.45 },
    { kind: 'hover', hover_foot: 'right', lift_height_m: 0.04, hold_s: 2.5 },
  ] });
  assert.equal(timeline.params.segments[2].kind, 'hover');
  assert.match(summarizeParams(timeline.params), /悬停抬右脚/);

  assert.throws(() => validateInput({ pattern: 'composite', segments: [{ kind: 'jump' }] }), /无法识别/);
  assert.throws(() => validateInput({ pattern: 'composite', segments: new Array(7).fill({ kind: 'straight', length_m: 0.1 }) }), /最多 6 段/);

  // segments only shape a composite trajectory
  const lineWithSegments = validateInput({ pattern: 'line', segments: [{ kind: 'straight', length_m: 0.2 }] });
  assert.equal(lineWithSegments.params.segments, undefined);
  assert.ok(lineWithSegments.warnings.some((w) => w.includes('composite')));
});

await test('hover (single-foot hold) validates its own params', () => {
  const dflt = validateInput({ pattern: 'hover' });
  assert.equal(dflt.params.pattern, 'hover');
  assert.equal(dflt.params.hover_foot, 'right');
  assert.equal(dflt.params.lift_height_m, 0.04);
  assert.equal(dflt.params.hold_s, 2.5);
  assert.match(summarizeParams(dflt.params), /单脚悬停：右脚抬起 4\.0 cm · 保持 2\.500 s/);

  const left = validateInput({ pattern: 'hover', hover_foot: '左脚', lift_height_m: 0.06, hold_s: 3 });
  assert.equal(left.params.hover_foot, 'left');
  assert.match(summarizeParams(left.params), /左脚抬起 6\.0 cm/);

  assert.throws(() => validateInput({ pattern: 'hover', lift_height_m: 0.5 }), /lift_height_m=0\.500 超出允许范围 0\.02–0\.08/);
  assert.throws(() => validateInput({ pattern: 'hover', hold_s: 9 }), /hold_s=9 超出允许范围 0\.5/);
  assert.throws(() => validateInput({ pattern: 'hover', hover_foot: 'tail' }), /hover_foot/);

  // hover fields are ignored (with a warning) for other patterns
  const line = validateInput({ pattern: 'line', lift_height_m: 0.05 });
  assert.equal(line.params.lift_height_m, undefined);
  assert.ok(line.warnings.some((w) => w.includes('pattern="hover"')));
});

await test('buildTemplates carries schema, defaults and recent tasks', () => {
  const payload = buildTemplates({ recentTasks: [{ task_id: 't1', params: { pattern: 'arc' } }] });
  assert.equal(payload.templates.length, 5);
  assert.equal(payload.parameter_schema.step_length_m.minimum, 0.02);
  assert.equal(payload.parameter_schema.pattern.values.length, 5);
  assert.equal(payload.recent_tasks.length, 1);
  assert.deepEqual(payload.last_params, { pattern: 'arc' });
  assert.ok(payload.synonyms_zh.pattern.figure8.includes('8字'));
});

// --------------------------------------------------------------- store ----
const clip = path.join(tmpRoot, 'clip.mp4');
fs.writeFileSync(clip, Buffer.alloc(8192, 7));
const dataDir = path.join(tmpRoot, 'data');
const store = new PreviewStore({
  pluginDir: path.join(here, '..'),
  config: { dataDir, demoVideo: clip, engine: 'demo', waitMs: 10_000 },
});
store.init();

await test('demo task runs and writes preview.mp4 + metrics.json', async () => {
  const record = store.create(validateInput({ pattern: 'arc', radius_m: 0.12 }).params, { callId: 'call-1' });
  const settled = await store.waitFor(record, 10_000);
  assert.equal(settled.status, 'done');
  assert.ok(fs.existsSync(path.join(dataDir, 'tasks', record.id, 'preview.mp4')));
  const metrics = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks', record.id, 'metrics.json'), 'utf8'));
  assert.equal(metrics.engine, 'demo');
  assert.equal(metrics.params.radius_m, 0.12);
  assert.ok(settled.video_url.endsWith(`/tasks/${record.id}/video`));
  assert.ok(settled.metrics_summary);
  assert.equal(settled.call_id, 'call-1');
});

await test('restored list survives a store re-init (durable task.json)', () => {
  const restored = new PreviewStore({
    pluginDir: path.join(here, '..'),
    config: { dataDir, demoVideo: clip, engine: 'demo' },
  });
  restored.init();
  assert.equal(restored.list().length, 1);
  assert.equal(restored.list()[0].status, 'done');
});

// ---------------------------------------------------------------- http ----
const templates = () => buildTemplates({ recentTasks: store.list(5) });
const server = http.createServer(createApiHandler({ store, templates, logger: () => {} }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const taskId = store.list()[0].id;

await test('GET /api/microduck/tasks returns the task list', async () => {
  const response = await fetch(`${base}/api/microduck/tasks`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tasks.length, 1);
  assert.equal(body.engine, 'demo');
  assert.equal(body.pipeline_ready, false);
});

await test('the tasks route filters by session_id for the conversation View', async () => {
  const scopedTask = store.create(validateInput({ pattern: 'line' }).params, { sessionId: 'session-scoped-1' });
  await store.waitFor(scopedTask, 10_000);

  const scoped = await (await fetch(`${base}/api/microduck/tasks?session_id=session-scoped-1`)).json();
  assert.equal(scoped.tasks.length, 1, 'exactly the task of that session');
  assert.equal(scoped.tasks[0].session_id, 'session-scoped-1');
  assert.equal(scoped.session_id, 'session-scoped-1');
  assert.ok(scoped.total_all_sessions >= 2);

  const other = await (await fetch(`${base}/api/microduck/tasks?session_id=session-unknown`)).json();
  assert.equal(other.tasks.length, 0);

  const sessions = await (await fetch(`${base}/api/microduck/sessions`)).json();
  assert.ok(sessions.sessions.some((entry) => entry.session_id === 'session-scoped-1'));
});

await test('GET /api/microduck/presets returns the catalogue', async () => {
  const response = await fetch(`${base}/api/microduck/presets`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).templates.length, 5);
});

await test('video route serves full body and byte ranges', async () => {
  const full = await fetch(`${base}/api/microduck/tasks/${taskId}/video`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal((await full.arrayBuffer()).byteLength, 8192);

  const ranged = await fetch(`${base}/api/microduck/tasks/${taskId}/video`, { headers: { range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 100-199/8192');
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  const suffix = await fetch(`${base}/api/microduck/tasks/${taskId}/video`, { headers: { range: 'bytes=-64' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 8128-8191/8192');

  const invalid = await fetch(`${base}/api/microduck/tasks/${taskId}/video`, { headers: { range: 'bytes=9000-9100' } });
  assert.equal(invalid.status, 416);
});

await test('unknown task and unknown route return JSON 404', async () => {
  const missing = await fetch(`${base}/api/microduck/tasks/nope`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'task_not_found');
  const unknown = await fetch(`${base}/api/microduck/nope`);
  assert.equal(unknown.status, 404);
});

await test('a rejecting trust guard yields 401 before any task data', async () => {
  const guarded = http.createServer(createApiHandler({
    store, templates, logger: () => {}, guard: () => 401,
  }));
  await new Promise((resolve) => guarded.listen(0, '127.0.0.1', resolve));
  const guardedBase = `http://127.0.0.1:${guarded.address().port}`;
  const response = await fetch(`${guardedBase}/api/microduck/tasks`);
  assert.equal(response.status, 401);
  await new Promise((resolve) => guarded.close(resolve));
});

await new Promise((resolve) => server.close(resolve));
store.dispose();

// ------------------------------------------------- real engine (subprocess) ----
// A fake "interpreter" exercises the real-pipeline code path: spawn, exit code
// handling, metrics parsing and the stderr tail on failure. No MuJoCo needed.
const fakePlugin = path.join(tmpRoot, 'fake-plugin');
const fakePipeline = path.join(fakePlugin, 'pipeline');
fs.mkdirSync(fakePipeline, { recursive: true });
fs.writeFileSync(path.join(fakePipeline, 'run_preview.py'), '# stub: the fake interpreter ignores this file\n');
fs.writeFileSync(path.join(fakePipeline, 'ready.json'), JSON.stringify({ ready: true }));

const fakeOk = path.join(tmpRoot, 'fake-python-ok.sh');
fs.writeFileSync(fakeOk, `#!/bin/sh
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--out-dir" ]; then out="$a"; fi
  prev="$a"
done
[ -z "$out" ] && { echo "ERROR: no --out-dir" >&2; exit 2; }
mkdir -p "$out"
printf 'FAKEMP4DATA' > "$out/preview.mp4"
printf '%s' '{"schema_version":1,"engine":"real","params":{"pattern":"line"},"frames":300,"fps":25,"duration_s":12,"motion_duration_s":12.5,"geometry":{"ok":true,"degraded":false,"effective_pattern":"line","degrade_reason":null,"hard_error_count":0,"checks":{"min_joint_margin_deg":12.5,"max_joint_speed_rad_s":3.1,"min_sole_z_mm":0.4,"min_nonfoot_z_mm":18,"self_penetrating_contacts":0}},"warnings":[],"created_at":"2026-10-27T00:00:00Z"}' > "$out/metrics.json"
exit 0
`);
const fakeFail = path.join(tmpRoot, 'fake-python-fail.sh');
fs.writeFileSync(fakeFail, `#!/bin/sh
echo "authoring line 12/300"
echo "ERROR: figure8 needs radius_m >= 0.08 on this robot" >&2
exit 3
`);
fs.chmodSync(fakeOk, 0o755);
fs.chmodSync(fakeFail, 0o755);

await test('real engine runs the pipeline subprocess and parses metrics', async () => {
  const realStore = new PreviewStore({
    pluginDir: fakePlugin,
    config: { dataDir: path.join(tmpRoot, 'real-data'), engine: 'auto', python: fakeOk, waitMs: 15_000 },
  });
  realStore.init();
  assert.equal(realStore.resolveEngine().engine, 'real');
  const record = realStore.create(validateInput({ pattern: 'line' }).params, { warnings: [] });
  const settled = await realStore.waitFor(record, 15_000);
  assert.equal(settled.status, 'done');
  assert.equal(settled.engine, 'real');
  assert.ok(settled.video_path.endsWith('preview.mp4'));
  assert.equal(settled.metrics_summary.frames, 300);
  assert.equal(settled.metrics_summary.geometry_ok, true);
  assert.equal(settled.metrics.engine, 'real');
  realStore.dispose();
});

await test('real engine reports a non-zero exit with the stderr tail', async () => {
  const failStore = new PreviewStore({
    pluginDir: fakePlugin,
    config: { dataDir: path.join(tmpRoot, 'fail-data'), engine: 'real', python: fakeFail, waitMs: 15_000 },
  });
  failStore.init();
  const record = failStore.create(validateInput({ pattern: 'figure8' }).params, {});
  const settled = await failStore.waitFor(record, 15_000);
  assert.equal(settled.status, 'error');
  assert.match(settled.error, /exit 3/);
  assert.match(settled.error, /figure8 needs radius_m/);
  assert.equal(settled.video_path, null);
  failStore.dispose();
});

await test('auto engine falls back to demo without ready.json', () => {
  const notReady = path.join(tmpRoot, 'not-ready-plugin');
  fs.mkdirSync(path.join(notReady, 'pipeline'), { recursive: true });
  fs.writeFileSync(path.join(notReady, 'pipeline', 'run_preview.py'), '# stub\n');
  const autoStore = new PreviewStore({
    pluginDir: notReady,
    config: { dataDir: path.join(tmpRoot, 'auto-data'), engine: 'auto', python: fakeOk, demoVideo: clip },
  });
  const resolved = autoStore.resolveEngine();
  assert.equal(resolved.engine, 'demo');
  assert.match(resolved.reason, /ready\.json/);
  autoStore.dispose();
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
