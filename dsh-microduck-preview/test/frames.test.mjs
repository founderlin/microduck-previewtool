/**
 * Integration test for the live MuJoCo frame service (real python subprocess).
 *
 * Spawns pipeline/frame_server.py through lib/frames.js, renders a short orbit
 * sweep + time sweep, checks JPEG framing, measures latency, and writes two
 * frames for visual inspection.
 *
 * Run with:  node test/frames.test.mjs [taskId]
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FramePool } from '../lib/frames.js';
import { inferAssetsRoot } from '../lib/runtime.js';
import { createApiHandler } from '../lib/http.js';
import { PreviewStore } from '../lib/tasks.js';

if (process.env.MICRODUCK_FRAME_INTEGRATION !== '1' && !/^\d{8}-/.test(process.argv[2] ?? '')) {
  test('real MuJoCo frame integration (MICRODUCK_FRAME_INTEGRATION=1)', { skip: true }, () => {});
} else {
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const tasksRoot = path.join(os.homedir(), '.dsh', 'microduck-preview', 'tasks');
const reviewDir = path.join(repo, '.review');
fs.mkdirSync(reviewDir, { recursive: true });

/** Newest completed real task that still has its motion.json. */
function pickTask() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const ids = fs.readdirSync(tasksRoot)
    .filter((id) => fs.existsSync(path.join(tasksRoot, id, 'task.json')))
    .sort()
    .reverse();
  for (const id of ids) {
    const dir = path.join(tasksRoot, id);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
    if (record.status === 'done' && record.engine === 'real' && fs.existsSync(path.join(dir, 'motion.json'))) return id;
  }
  throw new Error('no completed real task with motion.json found');
}

const taskId = pickTask();
const taskDir = path.join(tasksRoot, taskId);
const motion = JSON.parse(fs.readFileSync(path.join(taskDir, 'motion.json'), 'utf8'));
const duration = Number(motion.duration_s) || 15;
console.log(`task ${taskId} · ${duration.toFixed(2)}s`);

const python = process.env.MICRODUCK_PYTHON
  ?? '/Users/founderlin/agent_zoo/microduck_rl-develop/.venv/bin/python';
const assetRoot = process.env.MICRODUCK_ASSET_ROOT ?? inferAssetsRoot(python);

const pool = new FramePool({ python, assetRoot, pluginDir: repo, logger: (...a) => console.error('[pool]', ...a) });
const started = Date.now();
const timings = [];
let checked = 0;

const isJpeg = (buffer) => buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[buffer.length - 2] === 0xFF && buffer[buffer.length - 1] === 0xD9;

try {
  // 1) cold start + first frame
  const first = await pool.render(taskId, taskDir, {
    t: 0, az: 130, el: -18, dist: 0.52, follow: true, lookat: [0, 0], w: 900, h: 600, shadows: true, quality: 85,
  });
  const coldMs = Date.now() - started;
  assert.ok(isJpeg(first.buffer), 'first frame is not a JPEG');
  assert.ok(first.buffer.length > 8_000, `frame suspiciously small: ${first.buffer.length} bytes`);
  console.log(`cold start + frame1: ${coldMs} ms (render ${first.ms} ms, ${first.buffer.length} bytes)`);
  fs.writeFileSync(path.join(reviewDir, 'viewer_frame_start.jpg'), first.buffer);
  checked += 1;

  // 2) orbit sweep at a fixed time (what dragging the mouse does)
  for (let i = 0; i < 24; i += 1) {
    const t0 = performance.now();
    const frame = await pool.render(taskId, taskDir, {
      t: duration * 0.5, az: 130 + i * 6, el: -18 + (i % 5), dist: 0.52, follow: true,
      lookat: [0, 0], w: 900, h: 600, shadows: true, quality: 85,
    });
    timings.push(performance.now() - t0);
    if (i === 12) {
      assert.ok(isJpeg(frame.buffer));
      fs.writeFileSync(path.join(reviewDir, 'viewer_frame_orbit.jpg'), frame.buffer);
    }
    checked += 1;
  }

  // 3) time sweep (what playing / scrubbing does) at 640x440 without shadows
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    await pool.render(taskId, taskDir, {
      t: (duration * i) / 10, az: 130, el: -18, dist: 0.52, follow: true,
      lookat: [0, 0], w: 640, h: 440, shadows: false, quality: 85,
    });
    timings.push(performance.now() - t0);
    checked += 1;
  }

  // 4) follow=false with an explicit lookat + zoom extremes must not throw
  for (const dist of [0.12, 2.4]) {
    const frame = await pool.render(taskId, taskDir, {
      t: 1, az: 90, el: -80, dist, follow: false, lookat: [0.1, -0.05],
      w: 480, h: 320, shadows: false, quality: 70,
    });
    assert.ok(isJpeg(frame.buffer));
    checked += 1;
  }

  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length / 2)];
  const p95 = timings[Math.floor(timings.length * 0.95)];
  const info = pool.info(taskId);
  console.log(`ready info: ${JSON.stringify(info)}`);
  console.log(`${checked} frames ok · round-trip p50 ${p50.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms · ~${Math.round(1000 / p50)} fps ceiling`);
  assert.ok(p50 < 120, `p50 latency too slow for an interactive viewer: ${p50} ms`);
  assert.ok(fs.existsSync(path.join(reviewDir, 'viewer_frame_start.jpg')));
  assert.ok(fs.existsSync(path.join(reviewDir, 'viewer_frame_orbit.jpg')));

  // 5) the HTTP routes the Web viewer actually calls
  const store = new PreviewStore({ pluginDir: repo, config: {}, logger: () => {} });
  store.init();
  const server = http.createServer(createApiHandler({
    store,
    frames: pool,
    templates: () => ({ templates: [] }),
    logger: () => {},
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const scene = await (await fetch(`${base}/api/microduck/tasks/${taskId}/scene`)).json();
  assert.equal(scene.interactive, true, 'scene metadata should mark this task interactive');
  assert.ok(scene.duration_s > 1);
  assert.ok(scene.default_camera);

  const response = await fetch(`${base}/api/microduck/tasks/${taskId}/frame?t=3.0&az=140&el=-20&dist=0.6&w=640&h=440&shadows=0`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(response.headers.get('x-mujoco-ms')) > 0, 'missing per-frame render timing header');
  const body = Buffer.from(await response.arrayBuffer());
  assert.ok(body.length > 5_000, `http frame too small: ${body.length}`);
  assert.equal(body[0], 0xFF);
  assert.equal(body[1], 0xD8);
  fs.writeFileSync(path.join(reviewDir, 'viewer_frame_http.jpg'), body);
  console.log(`http frame route: ${body.length} bytes, render ${response.headers.get('x-mujoco-ms')} ms`);

  // A demo task has no motion.json -> the viewer must be told it is not interactive.
  const demoTask = store.list(50).find((record) => record.engine === 'demo' && record.status === 'done');
  if (demoTask) {
    const demoScene = await (await fetch(`${base}/api/microduck/tasks/${demoTask.id}/scene`)).json();
    assert.equal(demoScene.interactive, false, 'demo task must not claim an interactive scene');
    const demoFrame = await fetch(`${base}/api/microduck/tasks/${demoTask.id}/frame?t=0`);
    assert.equal(demoFrame.status, 409);
  }

  await new Promise((resolve) => server.close(resolve));
  store.dispose();

  console.log('frame service checks passed');
} finally {
  pool.dispose();
}

}
