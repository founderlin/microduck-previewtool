import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, listRewards, setReward, addReward, removeReward, exportRewards } from '../lib/rewards.js';
import { inferAssetsRoot } from '../lib/runtime.js';
import { validateInput, inheritParams } from '../lib/spec.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real source signatures gate cards; recipes are task-bound, immutable and signed', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'microduck-recipe-'));
  try {
    for (const dir of ['pipeline', 'rewards', 'src/training']) fs.mkdirSync(path.join(temp, dir), { recursive: true });
    fs.copyFileSync(path.join(root, 'pipeline/reward_catalog.py'), path.join(temp, 'pipeline/reward_catalog.py'));
    fs.writeFileSync(path.join(temp, 'src/training/rewards.py'), 'def velocity(env, std, command_name):\n    return 1\n\ndef penalty(env):\n    return 0\n');
    const term = { id: 'velocity', kind: 'reward', function: 'training.rewards:velocity', weight: { min: 0, max: 4, default: 2 }, params: { std: { min: .1, max: 1, default: .3 } }, fixed_params: { command_name: 'twist' } };
    fs.writeFileSync(path.join(temp, 'rewards/catalog.json'), JSON.stringify({ terms: [term, { id: 'penalty', kind: 'penalty', function: 'training.rewards:penalty', weight: { min: -2, max: 0, default: -.1 }, params: {} }, { ...term, id: 'invalid', function: 'training.rewards:missing' }], presets: { walk: ['velocity'], hover: ['penalty'] } }));
    const config = { pluginDir: temp, assetsRoot: temp, dataDir: path.join(temp, 'data'), python: 'python3' };
    assert.deepEqual(validateCatalog(config).map((v) => v.ok), [true, true, false]);
    assert.throws(() => addReward(config, 'chat', 'invalid', 'line', 'task-a'), /不可启用/);
    assert.throws(() => setReward(config, 'chat', 'velocity', { weight: -1 }, 'line', 'task-a'), /权重/);
    assert.throws(() => setReward(config, 'chat', 'velocity', { params: { unknown: 1 } }, 'line', 'task-a'), /未知/);
    const first = setReward(config, 'chat', 'velocity', { weight: 3, params: { std: .4 }, active_phases: ['walk'] }, 'line', 'task-a');
    const second = setReward(config, 'chat', 'velocity', { weight: 1 }, 'line', 'task-a');
    assert.notEqual(first.version, second.version);
    assert.equal(listRewards(config, 'chat', 'line', 'task-b').selection[0].weight, 2);
    assert.equal(listRewards(config, 'other-chat', 'line', 'task-a').selection[0].weight, 2);
    assert.ok(fs.existsSync(path.join(temp, 'data/sessions/chat/rewards/versions', `task-a-${first.version}.json`)));
    assert.deepEqual(exportRewards(config, 'chat', 'line', 'task-a').terms[0].params, { command_name: 'twist', std: .4 });
    removeReward(config, 'chat', 'velocity', 'line', 'task-a');
    assert.equal(exportRewards(config, 'chat', 'line', 'task-a').terms.length, 0);
    assert.throws(() => listRewards(config, '../bad', 'line', 'task-a'), /无效/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('asset inference and timeline degradation are explicit', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'microduck-assets-'));
  try {
    const xml = path.join(temp, 'src/mjlab_microduck/robot/microduck/robot_groundcontact.xml'); fs.mkdirSync(path.dirname(xml), { recursive: true }); fs.writeFileSync(xml, '<mujoco/>');
    assert.equal(inferAssetsRoot(path.join(temp, '.venv/bin/python')), temp);
    const value = validateInput({ pattern: 'composite', segments: [{ kind: 'sidestep', side: 'right', length_m: .2 }, { kind: 'hover' }, { kind: 'stand' }] });
    assert.ok(value.warnings.some((v) => /右转 90°再直行/.test(v)));
    assert.equal(value.params.segments[1].lift_height_m, .04);
    assert.throws(() => validateInput({ pattern: 'composite', segments: [{ kind: 'sidestep', side: 'up' }] }), /side/);
    assert.equal(inheritParams({ pattern: 'hover' }, value.params).merged.segments, undefined);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('review verification rejects changed artifact evidence', async () => {
  const { createHash } = await import('node:crypto');
  const { verifyPack } = await import('../lib/pack.js');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-review-'));
  const sha = (v) => createHash('sha256').update(v).digest('hex');
  try {
    const documents = { 'command.json': { times: [0,.02] }, 'rewards.json': { terms: [] }, 'physics.json': { handoff_ready: true, risks: [] }, 'robot_sources.json': {}, 'tool_sources.json': {} };
    const files = {};
    for (const [name, value] of Object.entries(documents)) { const content = JSON.stringify(value); fs.writeFileSync(path.join(temp, name), content); files[name] = sha(content); }
    const binding = { task_id: 'task-a', session_id: 'chat-a', files, params: { pattern: 'hover' } };
    fs.writeFileSync(path.join(temp, 'review.json'), JSON.stringify({ ...binding, review_id: sha(JSON.stringify(binding)) }));
    // No enabled terms means no dependency on a training runtime for this fixture.
    fs.mkdirSync(path.join(temp, 'rewards')); fs.writeFileSync(path.join(temp, 'rewards/catalog.json'), '{"terms":[]}');
    const config = { pluginDir: temp, assetsRoot: temp, python: '/missing/python' };
    assert.equal(verifyPack(config, temp).ok, true);
    fs.appendFileSync(path.join(temp, 'command.json'), ' ');
    const changed = verifyPack(config, temp);
    assert.equal(changed.ok, false); assert.equal(changed.handoff_ready, false);
    assert.ok(changed.blockers.some((v) => v.includes('command.json')));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
