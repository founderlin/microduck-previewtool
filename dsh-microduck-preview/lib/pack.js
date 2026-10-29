import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { exportRewards, validateCatalog } from './rewards.js';
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(config, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, ['-B', path.join(config.pluginDir, 'pipeline', script), ...args], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MICRODUCK_ASSET_ROOT: config.assetsRoot, MPLCONFIGDIR: path.join(config.dataDir, '.mpl') } });
    let output = ''; let settled = false;
    const outIndex = args.indexOf('--out-dir');
    const log = outIndex >= 0 ? fs.createWriteStream(path.join(args[outIndex + 1], `${script}.log`)) : null;
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); log?.end(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); finish(new Error(`${script} 超时；保留产物与未完成状态。`)); }, 180_000);
    child.stdout.on('data', (c) => { output = (output + c).slice(-6000); log?.write(c); }); child.stderr.on('data', (c) => { output = (output + c).slice(-6000); log?.write(c); });
    child.once('error', finish); child.once('close', (code) => finish(code ? new Error(`${script} exit ${code}: ${output.slice(-1500)}`) : null));
  });
}
export async function packTask(config, record, owner) {
  if (record.status !== 'done' || record.engine !== 'real') throw new Error('只能打包已完成的真实任务，DEMO 不可打包。');
  const taskDir = path.join(config.dataDir, 'tasks', record.id);
  const motion = JSON.parse(fs.readFileSync(path.join(taskDir, 'motion.json')));
  const frames = motion.times?.length;
  if (motion.joint_names?.length !== 14 || new Set(motion.joint_names).size !== 14 || motion.control_hz !== 50 || !frames || frames < 2 || motion.times.some((v, i) => !Number.isFinite(v) || (i && Math.abs(v - motion.times[i - 1] - .02) > 1e-6))) throw new Error('训练包要求 50 Hz / 14 关节 motion.json。');
  for (const [name, width] of Object.entries({ joint_pos: 14, root_pos: 3, root_quat_wxyz: 4, contact: 2 })) {
    if (motion[name]?.length !== frames || motion[name].some((row) => !Array.isArray(row) || row.length !== width || row.some((v) => !Number.isFinite(v)))) throw new Error(`motion.${name} 帧结构无效。`);
  }
  const command = JSON.parse(fs.readFileSync(path.join(taskDir, 'command.json')));
  if (command.times.length !== motion.times.length || command.times.some((v, i) => Math.abs(v - motion.times[i]) > 1e-8)) throw new Error('command 与 motion 帧未对齐。');
  for (const key of ['lin_vel_x', 'ang_vel_z', 'phase', 'support_foot']) if (command[key]?.length !== frames) throw new Error(`command.${key} 帧未对齐。`);
  const rewards = exportRewards(config, owner, record.params.pattern, record.id);
  const dir = path.join(config.dataDir, 'packs', `${record.id}-${randomUUID().slice(0, 8)}`); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n');
  write('state.json', { status: 'preflight_running', new_PPO_updates: 0 });
  for (const name of ['motion.json', 'command.json']) fs.copyFileSync(path.join(taskDir, name), path.join(dir, name));
  if (fs.existsSync(path.join(taskDir, 'preview.mp4'))) fs.copyFileSync(path.join(taskDir, 'preview.mp4'), path.join(dir, 'preview.mp4'));
  write('rewards.json', rewards);
  const criteria = config.taskCriteria ?? { minimum_pass_fraction: 0.8, maximum_mean_joint_rmse_deg: null, maximum_tilt_deg: null, maximum_foot_rmse_mm: null, minimum_contact_agreement: null, maximum_support_speed_mm_s: null };
  const criterionKeys = ['minimum_pass_fraction', 'maximum_mean_joint_rmse_deg', 'maximum_tilt_deg', 'maximum_foot_rmse_mm', 'minimum_contact_agreement', 'maximum_support_speed_mm_s'];
  if (!criteria || Array.isArray(criteria) || typeof criteria !== 'object' || Object.entries(criteria).some(([k, v]) => !criterionKeys.includes(k) || (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (['minimum_pass_fraction', 'minimum_contact_agreement'].includes(k) && v > 1))))) throw new Error('taskCriteria 必须为已知、非负且有限的验收阈值或 null。');
  write('task_criteria.json', criteria);
  try {
    await run(config, 'physics_preflight.py', ['--task-dir', taskDir, '--out-dir', dir, '--asset-root', config.assetsRoot, '--task', config.preflightTask ?? 'Mjlab-Velocity-Flat-MicroDuck', '--seeds', JSON.stringify(config.preflightSeeds ?? [123, 2026])]);
  } catch (error) { write('state.json', { status: 'preflight_failed', error: error.message, new_PPO_updates: 0 }); throw error; }
  const physics = JSON.parse(fs.readFileSync(path.join(dir, 'physics.json')));
  write('tool_sources.json', Object.fromEntries(['pipeline/author_walk.py', 'pipeline/command_track.py', 'pipeline/physics_preflight.py', 'lib/pack.js', 'lib/rewards.js', 'lib/runtime.js', 'pipeline/reward_catalog.py', 'rewards/catalog.json'].map((name) => [name, sha(path.join(config.pluginDir, name))])));
  const files = Object.fromEntries(fs.readdirSync(dir).filter((name) => !['state.json', 'review.json'].includes(name) && fs.statSync(path.join(dir, name)).isFile()).map((name) => [name, sha(path.join(dir, name))]));
  const binding = { task_id: record.id, session_id: owner, files, params: record.params };
  const review = { schema_version: 1, ...binding, review_id: createHash('sha256').update(JSON.stringify(binding)).digest('hex'), pack_id: path.basename(dir), pack_dir: dir, eligible_for_review: physics.eligible_for_review, handoff_ready: physics.handoff_ready, risks: physics.risks, handoff: { state: physics.handoff_ready ? 'needs_human_review' : 'blocked', blockers: physics.handoff_blockers, recipe_version: rewards.version, note: '本包是训练输入与物理审核材料；由训练流程显式导入 command/rewards/task_criteria，用户确认确切版本后再开启独立试训阶段。本项目不启动 PPO。' }, created_at: new Date().toISOString(), training_started: false };
  write('review.json', review); write('state.json', { status: physics.eligible_for_review ? 'needs_review' : 'blocked_geometry', new_PPO_updates: 0 });
  return review;
}
export function verifyPack(config, dir) {
  const review = JSON.parse(fs.readFileSync(path.join(dir, 'review.json')));
  const blockers = [];
  const binding = { task_id: review.task_id, session_id: review.session_id, files: review.files, params: review.params };
  if (createHash('sha256').update(JSON.stringify(binding)).digest('hex') !== review.review_id) blockers.push('审核版本哈希不匹配');
  const verifyFiles = (base, files) => { for (const [name, digest] of Object.entries(files)) { const file = path.resolve(base, name); if (!file.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(file) || sha(file) !== digest) blockers.push(`文件已变化：${name}`); } };
  verifyFiles(dir, review.files);
  for (const [manifest, root] of [['robot_sources.json', config.assetsRoot], ['tool_sources.json', config.pluginDir]]) {
    const file = path.join(dir, manifest); if (!fs.existsSync(file)) blockers.push(`缺少 ${manifest}`); else verifyFiles(root, JSON.parse(fs.readFileSync(file)));
  }
  const physics = JSON.parse(fs.readFileSync(path.join(dir, 'physics.json')));
  const recipe = JSON.parse(fs.readFileSync(path.join(dir, 'rewards.json')));
  const current = validateCatalog(config, true);
  for (const term of recipe.terms) if (current.find((v) => v.id === term.id)?.source_sha256 !== term.source?.source_sha256) blockers.push(`奖励函数源码已变化：${term.id}`);
  return { ok: blockers.length === 0, review_id: review.review_id, handoff_ready: blockers.length === 0 && physics.handoff_ready, blockers, risks: physics.risks, training_started: false };
}
export function verifyOwnedPack(config, id, owner) {
  if (typeof id !== 'string' || !/^[\w-]{1,120}$/.test(id)) throw new Error('无效审核包标识。');
  const dir = path.join(config.dataDir, 'packs', id);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'review.json')));
  if (record.session_id !== owner) throw new Error('当前对话中没有这个审核包。');
  return verifyPack(config, dir);
}
export async function explainTerm(config, record, term) {
  if (record.status !== 'done' || record.engine !== 'real') throw new Error('释义需要已完成的真实动作。');
  const taskDir = path.join(config.dataDir, 'tasks', record.id);
  const motion = path.join(taskDir, 'motion.json');
  const validation = validateCatalog(config, true).find((v) => v.id === term.id);
  if (!validation?.ok) throw new Error(validation?.error ?? '奖励函数不可解析。');
  const cache_key = createHash('sha256').update(JSON.stringify({ motion: sha(motion), command: sha(path.join(taskDir, 'command.json')), term: { ...term, selected: term.selected ? { params: term.selected.params } : null }, mode: 'scene-v1', source: validation.source_sha256, tool: sha(path.join(config.pluginDir, 'pipeline/explain_term.py')), model: sha(path.join(config.assetsRoot, 'src/mjlab_microduck/robot/microduck/robot_groundcontact.xml')) })).digest('hex').slice(0, 16);
  const dir = path.join(config.dataDir, 'explain', record.id, `${term.id}-${cache_key}`); const scores = path.join(dir, 'scores.json');
  if (fs.existsSync(scores)) return { ...JSON.parse(fs.readFileSync(scores)), cache_key, cached: true };
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'term.json'), JSON.stringify(term, null, 2));
  await run(config, 'explain_term.py', ['--motion-json', motion, '--command-json', path.join(taskDir, 'command.json'), '--term-json', path.join(dir, 'term.json'), '--out-dir', dir, '--asset-root', config.assetsRoot, '--trajectory-only']);
  return { ...JSON.parse(fs.readFileSync(scores)), cache_key, cached: false };
}
