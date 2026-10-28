import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ROBOT_XML_REL = 'src/mjlab_microduck/robot/microduck/robot_groundcontact.xml';
export const DEFAULT_PYTHON = path.join(os.homedir(), 'agent_zoo/microduck_rl-develop/.venv/bin/python');
export const expandHome = (value) => path.resolve(String(value).replace(/^~(?=\/|$)/, os.homedir()));

export function inferAssetsRoot(python = DEFAULT_PYTHON) {
  const checkout = path.resolve(path.dirname(python), '../..');
  const candidates = [checkout, path.join(os.homedir(), 'agent_zoo/microduck_rl-develop')];
  return candidates.find((root) => fs.existsSync(path.join(root, ROBOT_XML_REL))) ?? checkout;
}

export function workbenchConfig(store) {
  return { ...store.config, pluginDir: store.pluginDir, dataDir: path.dirname(store.tasksDir),
    python: store.python, assetsRoot: store.assetsRoot,
    preflightTask: store.config.preflightTask ?? 'Mjlab-Velocity-Flat-MicroDuck',
    preflightSeeds: store.config.preflightSeeds ?? [123, 2026] };
}
