import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { apply } from '../index.js';
import { startServer } from '../../codex-microduck-preview/lib/server.mjs';
import { fileURLToPath } from 'node:url';
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('DSH tools isolate session inheritance and both hosts serve identical workbench assets', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-parity-'));
  const demo = path.join(temp, 'demo.mp4'); fs.writeFileSync(demo, 'test fixture');
  const tools = new Map(), cleanup = []; let handler;
  const ctx = { effect(fn) { const stop = fn(); if (typeof stop === 'function') cleanup.push(stop); }, get() { return null; }, webServer: { register(value) { handler = value.handler; return () => {}; } }, tools: { register(tool) { tools.set(tool.name, tool); } } };
  apply(ctx, { engine: 'demo', demoVideo: demo, dataDir: path.join(temp, 'dsh'), python: '/missing/python', waitMs: 0 });
  const dsh = http.createServer(handler); await new Promise((resolve) => dsh.listen(0, '127.0.0.1', resolve));
  const codex = await startServer({ projectRoot: path.dirname(pluginDir), skillRoot: path.join(path.dirname(pluginDir), 'codex-microduck-preview'), pluginDir, dataDir: path.join(temp, 'codex'), assetsRoot: temp, python: '/missing/python', engine: 'demo', demoVideo: demo, host: '127.0.0.1', port: 0 });
  try {
    for (const name of ['duck_doctor', 'duck_rewards', 'duck_explain', 'duck_pack', 'duck_verify']) assert.ok(tools.has(name));
    const exec = (id) => ({ agent: { id } });
    const a = await tools.get('duck_preview').execute({ pattern: 'arc', direction: 'backward' }, exec('chat-A'));
    const b = await tools.get('duck_preview').execute({ pattern: 'hover' }, exec('chat-B'));
    const tweak = await tools.get('duck_preview').execute({ radius_m: .12 }, exec('chat-A'));
    const templates = JSON.parse(await tools.get('duck_templates').execute({}, exec('chat-A')));
    assert.equal(templates.recent_tasks[0].params.pattern, 'arc');
    assert.equal(templates.recent_tasks[0].params.direction, 'backward');
    assert.equal(templates.recent_tasks[0].params.radius_m, .12);
    assert.equal(templates.recent_tasks.length, 2);
    await assert.rejects(tools.get('duck_status').execute({ task_id: a.task_id }, exec('chat-B')), /当前对话/);
    assert.equal(b.engine, 'demo'); assert.ok(tweak.task_id);
    const dshOrigin = `http://127.0.0.1:${dsh.address().port}`;
    for (const asset of ['app.js', 'styles.css']) {
      const [left, right] = await Promise.all([fetch(`${dshOrigin}/api/microduck/workbench/${asset}`).then((r) => r.text()), fetch(`${codex.origin}/${asset}`).then((r) => r.text())]);
      assert.equal(left, right);
    }
    const page = await (await fetch(`${dshOrigin}/api/microduck/workbench/?session_id=chat-A`)).text();
    assert.match(page, /id="viewport"/); assert.match(page, /id="rewards"/); assert.match(page, /id="execute"/);
    assert.doesNotMatch(page, /segments-editor|reward-cards|pack-button|<video/);
    const foreign = await fetch(`${dshOrigin}/api/microduck/rewards?session_id=chat-B&task_id=${a.task_id}`);
    assert.equal(foreign.status, 404);
    assert.equal((await fetch(`${dshOrigin}/api/microduck/tasks/${a.task_id}/pack?session_id=chat-A`, { method: 'POST' })).status, 400);
  } finally { await codex.close(); await new Promise((resolve) => dsh.close(resolve)); for (const fn of cleanup.reverse()) fn(); fs.rmSync(temp, { recursive: true, force: true }); }
});
