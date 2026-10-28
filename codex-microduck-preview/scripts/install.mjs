#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const source = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const skillsRoot = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
const target = path.join(skillsRoot, 'codex-microduck-preview');
const args = new Set(process.argv.slice(2));
const result = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  const unexpected = [...args].filter((arg) => !['--check', '--uninstall'].includes(arg));
  if (unexpected.length || args.size > 1) throw new Error('仅支持无参数安装、--check 检查或 --uninstall 卸载。');
  const sibling = path.resolve(source, '../dsh-microduck-preview');
  if (!fs.existsSync(path.join(source, 'SKILL.md')) || !fs.existsSync(path.join(sibling, 'lib/tasks.js'))) {
    throw new Error('技能源码或相邻 dsh-microduck-preview 核心缺失，请保留完整的 microduck-previewtool 项目。');
  }
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let matching = false;
  if (stat?.isSymbolicLink()) {
    try { matching = fs.realpathSync(target) === source; } catch { /* broken unrelated link */ }
  }
  if (args.has('--check')) {
    result({ ok: matching, installed: matching, source, target, conflict: Boolean(stat && !matching) });
    if (!matching) process.exitCode = 1;
  } else if (args.has('--uninstall')) {
    if (stat && !matching) throw new Error(`拒绝移除其他来源的文件或技能：${target}`);
    if (matching) fs.unlinkSync(target);
    result({ ok: true, removed: matching, target, message: '项目源码与任务产物保留。' });
  } else {
    if (stat && !matching) throw new Error(`安装位置已存在不同内容，未覆盖：${target}`);
    if (!matching) { fs.mkdirSync(skillsRoot, { recursive: true }); fs.symlinkSync(source, target, 'dir'); }
    result({ ok: true, installed: true, reused: matching, source, target,
      message: '技能已链接。请在新对话中调用 $codex-microduck-preview；若列表尚未刷新，重新加载 Codex。' });
  }
} catch (error) {
  result({ ok: false, error: error?.message ?? String(error) });
  process.exitCode = 1;
}
