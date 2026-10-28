#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, doctor } from '../lib/config.mjs';

const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

export function parseArgs(argv) {
  const args = { command: argv[0] ?? 'help', _: [] };
  for (let i = 1; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const equal = item.indexOf('=');
    const key = item.slice(2, equal < 0 ? undefined : equal);
    if (!key) throw new Error('参数名不能为空。');
    if (equal >= 0) args[key] = item.slice(equal + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else args[key] = true;
  }
  return args;
}

function readService(config) {
  try { return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'service.json'), 'utf8')); }
  catch { return null; }
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.username === '' && url.password === ''
      && url.pathname === '/' && url.search === '' && url.hash === '' ? url.origin : null;
  } catch { return null; }
}

async function request(origin, route, options = {}) {
  const { timeout = 30_000, ...init } = options;
  const response = await fetch(`${origin}${route}`, { ...init, signal: AbortSignal.timeout(timeout) });
  let value;
  try { value = await response.json(); }
  catch { throw new Error(`本地服务返回了无效 JSON（HTTP ${response.status}）。`); }
  if (!response.ok) throw new Error(value.message ?? value.error ?? `HTTP ${response.status}`);
  return value;
}

async function inspectService(config) {
  const record = readService(config);
  const origin = safeOrigin(record?.origin);
  if (!origin || record.projectRoot !== config.projectRoot || !record.instance_id) return null;
  try {
    const health = await request(origin, '/api/microduck/health', { timeout: 1200 });
    if (health.projectRoot !== config.projectRoot || health.instance_id !== record.instance_id) return null;
    return { ...record, origin, health };
  } catch { return null; }
}

async function ensureService(config) {
  const active = await inspectService(config);
  if (active) return { ...active, reused: true };
  fs.mkdirSync(config.dataDir, { recursive: true });
  const logPath = path.join(config.dataDir, 'server.log');
  const log = fs.openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [scriptPath, 'serve'], {
    cwd: config.projectRoot, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, ...(process.env.MICRODUCK_CONFIG ? { MICRODUCK_CONFIG: path.resolve(process.env.MICRODUCK_CONFIG) } : {}) },
  });
  fs.closeSync(log);
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`服务启动失败：${spawnError.message}`);
    const service = await inspectService(config);
    if (service) return { ...service, reused: false };
    await sleep(200);
  }
  throw new Error(`本地服务未能启动。请查看 ${logPath}；也可运行 serve 在前台诊断。`);
}

function requireSession(args) {
  const session = args.session ?? process.env.CODEX_THREAD_ID;
  if (typeof session !== 'string' || !session.trim()) {
    throw new Error('缺少当前对话标识：传入 --session <稳定且唯一的对话标识>，或设置 CODEX_THREAD_ID。');
  }
  return session.trim();
}

function taskId(args) {
  const value = args.task ?? args._[0];
  if (typeof value !== 'string' || !value) throw new Error('请传入 --task <task_id>。');
  return value;
}

function routeWithSession(route, session) {
  return `${route}${route.includes('?') ? '&' : '?'}session_id=${encodeURIComponent(session)}`;
}

function viewerUrl(origin, session, task) {
  const url = new URL('/', origin);
  url.searchParams.set('session_id', session);
  if (task) url.searchParams.set('task_id', task);
  return url.href;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadConfig();
  if (args.command === 'help') {
    return {
      commands: ['doctor', 'start', 'serve', 'stop', 'templates', 'preview', 'status', 'history', 'viewer'],
      usage: 'node scripts/microduck.mjs <command> --session <id> [--params JSON | --params-file FILE] [--task ID] [--base-task ID] [--wait-ms 0..25000]',
      note: '会话命令需要 --session 或 CODEX_THREAD_ID。preview 默认立即返回任务；用 status 查询，不重复提交。',
    };
  }
  if (args.command === 'doctor') return doctor(config);
  if (args.command === 'serve') {
    const { startServer } = await import('../lib/server.mjs');
    const service = await startServer(config);
    const stop = async () => { await service.close(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return { ok: true, status: 'listening', origin: service.origin, projectRoot: config.projectRoot };
  }
  if (args.command === 'stop') {
    const service = await inspectService(config);
    if (!service) return { ok: true, stopped: false, message: '没有本项目可确认的运行中服务。' };
    return request(service.origin, '/api/microduck/shutdown', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-microduck-instance': service.instance_id },
      body: JSON.stringify({ instance_id: service.instance_id }),
    });
  }
  if (args.command === 'start') {
    const service = await ensureService(config);
    return { ok: true, origin: service.origin, pid: service.pid, reused: service.reused, instance_id: service.instance_id };
  }
  if (!['templates', 'preview', 'status', 'history', 'viewer'].includes(args.command)) throw new Error(`未知命令：${args.command}`);
  const session = requireSession(args);
  // Validate user input before starting a background process.
  let params;
  let waitMs;
  if (args.command === 'preview') {
    if (args.params !== undefined && args['params-file'] !== undefined) throw new Error('--params 与 --params-file 只能使用一个。');
    const raw = args['params-file'] !== undefined
      ? fs.readFileSync(path.resolve(String(args['params-file'])), 'utf8') : args.params ?? '{}';
    try { params = JSON.parse(raw); }
    catch { throw new Error('动作参数不是有效 JSON。'); }
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('动作参数必须是 JSON 对象。');
    waitMs = Number(args['wait-ms'] ?? 0);
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 25_000) throw new Error('--wait-ms 必须在 0–25000 毫秒范围内。');
  }
  if (args.command === 'status') taskId(args);
  const service = await ensureService(config);
  const origin = service.origin;
  if (args.command === 'templates') return request(origin, routeWithSession('/api/microduck/presets', session));
  if (args.command === 'history') return request(origin, routeWithSession('/api/microduck/tasks', session));
  if (args.command === 'preview') {
    return request(origin, '/api/microduck/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: session, params, wait_ms: waitMs,
        ...(args['base-task'] ? { base_task_id: String(args['base-task']) } : {}) }),
      timeout: Math.max(30_000, waitMs + 5000),
    });
  }
  if (args.command === 'status') {
    return request(origin, routeWithSession(`/api/microduck/tasks/${encodeURIComponent(taskId(args))}`, session));
  }
  let task = args.task ?? args._[0];
  if (task) {
    await request(origin, routeWithSession(`/api/microduck/tasks/${encodeURIComponent(task)}`, session));
  } else {
    const history = await request(origin, routeWithSession('/api/microduck/tasks', session));
    task = history.tasks?.[0]?.id;
  }
  return { ok: true, session_id: session, task_id: task ?? null, viewer_url: viewerUrl(origin, session, task) };
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  main().then((value) => {
    if (value !== undefined) emit(value);
    // A queued/running preview was accepted; callers must poll its ID, not retry submission.
    if (value?.ok === false && !['queued', 'running'].includes(value.status)) process.exitCode = 1;
  }).catch((error) => {
    emit({ ok: false, error: error?.message ?? String(error) });
    process.exitCode = 1;
  });
}
