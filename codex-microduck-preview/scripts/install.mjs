#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const source = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const root = path.dirname(source);
const args = process.argv.slice(2);
const cursor = args.includes('--cursor');
const mode = args.includes('--check') ? 'check' : args.includes('--uninstall') ? 'uninstall' : 'install';
const skillsRoot = cursor ? path.join(os.homedir(), '.cursor/skills') : path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
const names = ['codex-microduck-preview', 'microduck-preview-runtime', 'microduck-motion-compose', 'microduck-reward-studio', 'microduck-train-pack'];
const emit = (v) => process.stdout.write(JSON.stringify(v) + '\n');
try {
  if (args.some((a) => !['--cursor', '--check', '--uninstall'].includes(a)) || (args.includes('--check') && args.includes('--uninstall'))) throw new Error('支持 --cursor、--check 或 --uninstall。');
  const entries = names.map((name) => {
    const from = path.join(root, name), target = path.join(skillsRoot, name);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) throw new Error(`缺少子技能 ${from}`);
    let exists = false, matching = false;
    try { const stat = fs.lstatSync(target); exists = true; matching = stat.isSymbolicLink() && fs.realpathSync(target) === from; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { name, source: from, target, exists, matching };
  });
  if (mode === 'check') { const ok = entries.every((e) => e.matching); emit({ ok, installed: ok, entries }); if (!ok) process.exitCode = 1; }
  else {
    const conflict = entries.find((e) => e.exists && !e.matching); if (conflict) throw new Error(`拒绝覆盖或移除其他来源的技能：${conflict.target}`);
    if (mode === 'install') fs.mkdirSync(skillsRoot, { recursive: true });
    for (const entry of entries) {
      if (mode === 'install' && !entry.matching) fs.symlinkSync(entry.source, entry.target, 'dir');
      if (mode === 'uninstall' && entry.matching) fs.unlinkSync(entry.target);
    }
    emit({ ok: true, mode, entries, message: '只管理本项目的五个技能链接；源码与任务保留。' });
  }
} catch (e) { emit({ ok: false, error: e.message }); process.exitCode = 1; }
