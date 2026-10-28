import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../lib/server.mjs';

const run = promisify(execFile);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.dirname(skillRoot);
const cli = path.join(skillRoot, 'scripts/microduck.mjs');

test('CLI accepts asynchronous tasks without failure exit or duplicate submissions', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'microduck-cli-test-'));
  const clip = path.join(temporary, 'fixture.mp4');
  fs.writeFileSync(clip, Buffer.alloc(1024, 7));
  const config = {
    projectRoot, skillRoot, pluginDir: path.join(projectRoot, 'dsh-microduck-preview'),
    dataDir: path.join(temporary, 'data'), python: '/missing/python',
    assetsRoot: path.join(temporary, 'missing-assets'), host: '127.0.0.1', port: 0,
    engine: 'demo', demoVideo: clip, idleMs: 100,
  };
  const service = await startServer(config);
  const configFile = path.join(temporary, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...config, port: service.server.address().port }));
  const env = { ...process.env, MICRODUCK_CONFIG: configFile, MICRODUCK_DATA_DIR: config.dataDir,
    MICRODUCK_PORT: String(service.server.address().port), MICRODUCK_ENGINE: 'demo' };
  async function call(...args) {
    try {
      const result = await run(process.execPath, [cli, ...args], { env, timeout: 10_000 });
      return { code: 0, value: JSON.parse(result.stdout) };
    } catch (error) {
      if (typeof error.code !== 'number' || !error.stdout) throw error;
      return { code: error.code, value: JSON.parse(error.stdout) };
    }
  }
  try {
    const first = await call('preview', '--session', 'cli-regression', '--params', '{"pattern":"figure8"}');
    assert.equal(first.code, 0, 'accepted asynchronous submission must exit successfully');
    assert.ok(['running', 'queued'].includes(first.value.status));
    assert.equal(first.value.ok, false, 'task completion is distinct from command acceptance');
    assert.ok(first.value.task_id);
    const second = await call('preview', '--session', 'cli-regression', '--params', '{"radius_m":0.12}');
    assert.equal(second.code, 0, 'queued submission must also exit successfully');
    assert.equal(second.value.status, 'queued');
    const pending = await call('status', '--session', 'cli-regression', '--task', second.value.task_id);
    assert.equal(pending.code, 0, 'polling a pending task is not a command failure');
    assert.ok(['queued', 'running'].includes(pending.value.status));
    const invalid = await call('preview', '--session', 'cli-regression', '--params', '{"step_length_m":0.2}');
    assert.equal(invalid.code, 1);
    assert.equal(invalid.value.ok, false);
    const history = await call('history', '--session', 'cli-regression');
    assert.equal(history.code, 0);
    assert.equal(history.value.tasks.length, 2, 'polling and invalid input must not create extra tasks');
    assert.deepEqual(new Set(history.value.tasks.map((task) => task.task_id)), new Set([first.value.task_id, second.value.task_id]));
  } finally {
    await service.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('CLI exits unsuccessfully for a terminal pipeline error', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'microduck-cli-error-'));
  const config = {
    projectRoot, skillRoot, pluginDir: path.join(projectRoot, 'dsh-microduck-preview'),
    dataDir: path.join(temporary, 'data'), python: '/missing/python',
    assetsRoot: path.join(temporary, 'missing-assets'), host: '127.0.0.1', port: 0,
    engine: 'demo', demoVideo: path.join(temporary, 'missing.mp4'), idleMs: 100,
  };
  const service = await startServer(config);
  const configFile = path.join(temporary, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...config, port: service.server.address().port }));
  try {
    await assert.rejects(run(process.execPath, [cli, 'preview', '--session', 'cli-error', '--params', '{}', '--wait-ms', '5000'], {
      env: { ...process.env, MICRODUCK_CONFIG: configFile, MICRODUCK_DATA_DIR: config.dataDir,
        MICRODUCK_PORT: String(service.server.address().port), MICRODUCK_ENGINE: 'demo' },
      timeout: 10_000,
    }), (error) => {
      const value = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(value.status, 'error');
      assert.equal(value.ok, false);
      assert.match(value.error, /演示视频缺失/);
      return true;
    });
  } finally {
    await service.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
