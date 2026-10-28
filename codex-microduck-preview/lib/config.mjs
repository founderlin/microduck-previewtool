import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expand = (value, root) => path.resolve(root, String(value).replace(/^~(?=\/|$)/, os.homedir()));
import { ROBOT_XML_REL, DEFAULT_PYTHON, inferAssetsRoot } from '../../dsh-microduck-preview/lib/runtime.js';
import { validateCatalog } from '../../dsh-microduck-preview/lib/rewards.js';
export { inferAssetsRoot };

export function loadConfig() {
  const projectRoot = path.dirname(skillRoot);
  const configFile = process.env.MICRODUCK_CONFIG;
  const settings = configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  const resolve = (key, env, fallback) => expand(process.env[env] ?? settings[key] ?? fallback, projectRoot);
  const port = Number(process.env.MICRODUCK_PORT ?? settings.port ?? 47832);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port 必须为 0–65535 的整数。');
  const engine = process.env.MICRODUCK_ENGINE ?? settings.engine ?? 'real';
  if (!['real', 'demo', 'auto'].includes(engine)) throw new Error('engine 必须为 real / demo / auto。');
  const python = resolve('python', 'MICRODUCK_PYTHON', DEFAULT_PYTHON);
  const assetsExplicit = process.env.MICRODUCK_ASSET_ROOT ?? settings.assetsRoot;
  const assetsRoot = expand(assetsExplicit ?? inferAssetsRoot(python), projectRoot);
  return {
    projectRoot, skillRoot, pluginDir: path.join(projectRoot, 'dsh-microduck-preview'),
    dataDir: resolve('dataDir', 'MICRODUCK_DATA_DIR', '.runtime/codex'),
    python,
    assetsRoot,
    ...(settings.demoVideo ? { demoVideo: expand(settings.demoVideo, projectRoot) } : {}),
    host: '127.0.0.1', port, engine, idleMs: 45_000,
    preflightTask: settings.preflightTask ?? 'Mjlab-Velocity-Flat-MicroDuck',
    preflightSeeds: settings.preflightSeeds ?? [123, 2026],
    taskCriteria: settings.taskCriteria,
  };
}

/** Read-only dependency check: imports libraries and compiles the real XML, without starting GL. */
export async function doctor(config) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  const [major, minor] = process.versions.node.split('.').map(Number);
  check('node', major > 22 || (major === 22 && minor >= 19), process.version);
  for (const file of ['lib/spec.js', 'lib/tasks.js', 'lib/http.js', 'lib/frames.js', 'pipeline/run_preview.py', 'pipeline/frame_server.py']) {
    check(file, fs.existsSync(path.join(config.pluginDir, file)), path.join(config.pluginDir, file));
  }
  try { fs.accessSync(config.python, fs.constants.X_OK); check('python', true, config.python); }
  catch { check('python', false, `解释器不可执行：${config.python}`); }
  const xml = path.join(config.assetsRoot, ROBOT_XML_REL);
  check('robot_xml', fs.existsSync(xml), xml);
  const bamHelper = path.join(config.assetsRoot, 'scripts/train_microduck_cpu.py');
  check('bam_runtime', fs.existsSync(bamHelper), bamHelper);
  const rewards = validateCatalog(config, true);
  check('reward_catalog', rewards.every((r) => r.ok), rewards);

  if (checks.find((c) => c.name === 'python').ok && fs.existsSync(xml)) {
    try {
      const source = 'import sys,json,mujoco,numpy,scipy,PIL,imageio,imageio_ffmpeg; m=mujoco.MjModel.from_xml_path(sys.argv[1]); print(json.dumps({"mujoco":mujoco.__version__,"nq":m.nq,"bodies":m.nbody,"ffmpeg":imageio_ffmpeg.get_ffmpeg_exe()}))';
      const result = await run(config.python, ['-B', '-c', source, xml], { timeout: 25_000, maxBuffer: 100_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      check('dependencies_and_model', true, JSON.parse(result.stdout.trim()));
    } catch (e) { check('dependencies_and_model', false, (e.stderr || e.message).slice(-1600)); }
  }
  return { ok: checks.filter((c) => !['reward_catalog', 'bam_runtime'].includes(c.name)).every((c) => c.ok), workbench_ok: checks.every((c) => c.ok), checks, config };
}
