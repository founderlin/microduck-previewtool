import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expand = (value, root) => path.resolve(root, String(value).replace(/^~(?=\/|$)/, os.homedir()));

export function loadConfig() {
  const projectRoot = path.dirname(skillRoot);
  const configFile = process.env.MICRODUCK_CONFIG;
  const settings = configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  const resolve = (key, env, fallback) => expand(process.env[env] ?? settings[key] ?? fallback, projectRoot);
  const port = Number(process.env.MICRODUCK_PORT ?? settings.port ?? 47832);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port 必须为 0–65535 的整数。');
  const engine = process.env.MICRODUCK_ENGINE ?? settings.engine ?? 'real';
  if (!['real', 'demo', 'auto'].includes(engine)) throw new Error('engine 必须为 real / demo / auto。');
  return {
    projectRoot, skillRoot, pluginDir: path.join(projectRoot, 'dsh-microduck-preview'),
    dataDir: resolve('dataDir', 'MICRODUCK_DATA_DIR', '.runtime/codex'),
    python: resolve('python', 'MICRODUCK_PYTHON', '/Users/founderlin/agent_zoo/microduck_rl-develop/.venv/bin/python'),
    assetsRoot: resolve('assetsRoot', 'MICRODUCK_ASSET_ROOT', '/Users/founderlin/Desktop/RL研发/microduck-marseille'),
    ...(settings.demoVideo ? { demoVideo: expand(settings.demoVideo, projectRoot) } : {}),
    host: '127.0.0.1', port, engine, idleMs: 45_000,
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
  const xml = path.join(config.assetsRoot, 'src/mjlab_microduck/robot/microduck/robot_groundcontact.xml');
  check('robot_xml', fs.existsSync(xml), xml);
  if (checks.find((c) => c.name === 'python').ok && fs.existsSync(xml)) {
    try {
      const source = 'import sys,json,mujoco,numpy,scipy,PIL,imageio,imageio_ffmpeg; m=mujoco.MjModel.from_xml_path(sys.argv[1]); print(json.dumps({"mujoco":mujoco.__version__,"nq":m.nq,"bodies":m.nbody,"ffmpeg":imageio_ffmpeg.get_ffmpeg_exe()}))';
      const result = await run(config.python, ['-B', '-c', source, xml], { timeout: 25_000, maxBuffer: 100_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      check('dependencies_and_model', true, JSON.parse(result.stdout.trim()));
    } catch (e) { check('dependencies_and_model', false, (e.stderr || e.message).slice(-1600)); }
  }
  return { ok: checks.every((c) => c.ok), checks, config };
}
