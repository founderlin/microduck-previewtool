/**
 * Host half of @local/dsh-microduck-preview.
 *
 * Registers:
 *  - tools: `duck_templates` (catalogue + parameter schema + recent tasks),
 *           `duck_preview` (start a MuJoCo preview task), `duck_status` (poll)
 *  - the `/api/microduck/*` prefix route consumed by the Browser half
 *
 * Named exports only: the Loader reads `name`, `inject` and `apply` off the
 * module namespace — a default export would drop the injection metadata.
 */

import path from 'node:path';
import fs from 'node:fs';
import { workbenchConfig, ROBOT_XML_REL } from './lib/runtime.js';
import { listRewards, addReward, removeReward, setReward, catalogTerm, validateCatalog } from './lib/rewards.js';
import { packTask, explainTerm, verifyOwnedPack } from './lib/pack.js';
import { ownedTask, sessionId } from './lib/workbench.js';
import { fileURLToPath } from 'node:url';

import { PreviewStore } from './lib/tasks.js';
import { FramePool } from './lib/frames.js';
import { API_PREFIX, createApiHandler } from './lib/http.js';
import { buildTemplates, inheritParams, summarizeParams, validateInput } from './lib/spec.js';

export const name = 'microduck-preview';
export const inject = ['tools', 'webServer'];

/** Absolute plugin directory (the package root) — used to locate pipeline/. */
const pluginDir = path.dirname(fileURLToPath(import.meta.url));

const logger = (...args) => console.error('[microduck-preview]', ...args);

/** Tool result schema shared by `duck_preview` and `duck_status`. */
const RESULT_SCHEMA = {
  type: 'object',
  required: ['ok', 'status', 'task_id', 'engine', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
    task_id: { type: 'string' },
    engine: { type: 'string' },
    video_url: { type: 'string' },
    video_path: { type: 'string' },
    frames: { type: 'integer' },
    duration_s: { type: 'number' },
    geometry_ok: { type: 'boolean' },
    degraded: { type: 'boolean' },
    degrade_reason: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    elapsed_s: { type: 'number' },
    error: { type: 'string' },
    summary: { type: 'string' },
  },
};

/** Drop null/undefined members so the declared output schema stays exact. */
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

/** Chinese, model-facing sentence for one task snapshot. */
function summaryText(record) {
  const params = summarizeParams(record.params);
  const metrics = record.metrics_summary ?? null;
  if (record.status === 'done') {
    const parts = [`✅ 预览完成：${params}`];
    if (record.engine === 'demo') {
      parts.push(
        '⚠️ 这是 DEMO 片段：真实的 MuJoCo 管线尚未就绪（' + (record.engine_reason ?? '未知原因') + '），' +
        '视频内容不是本次参数渲染的动作，请如实告诉用户。',
      );
    }
    if (metrics) {
      if (metrics.frames) parts.push(`${metrics.frames} 帧 / ${metrics.duration_s ?? '?'} s`);
      if (metrics.degraded) {
        // A degraded run IS geometrically valid, but for a different trajectory:
        // say that in one sentence so the model cannot report "8 字已完成".
        const effective = metrics.effective_pattern
          ? `（实际轨迹：${metrics.effective_pattern}）`
          : '';
        parts.push(
          `⚠️ 轨迹已降级${effective}：${metrics.degrade_reason ?? '该轨迹在此机器人上不可行，已改为近似轨迹'}。` +
          '请如实告诉用户“没做到原轨迹，改成了什么”，不要说是原轨迹。',
        );
      } else if (metrics.geometry_ok === true) {
        parts.push('几何检查通过');
      }
    }
    parts.push(`视频文件：${record.video_path ?? '(无)'}`);
    if (record.video_url) parts.push('Web 面板 “Microduck Preview” 里可直接播放（video_url 同源路径）。');
    return parts.join(' · ');
  }
  if (record.status === 'error') {
    return `❌ 预览失败：${record.error ?? '未知错误'}`;
  }
  const elapsed = record.started_at
    ? Math.round((Date.now() - Date.parse(record.started_at)) / 1000)
    : 0;
  return `⏳ 渲染中（已 ${elapsed} s）：task_id=${record.id}。请调用 duck_status 继续等待，不要重复提交新任务。`;
}

/** Model-facing canonical value for one task. */
function toolValue(record) {
  const metrics = record.metrics_summary ?? null;
  return compact({
    ok: record.status === 'done',
    status: record.status,
    task_id: record.id,
    engine: record.engine ?? 'unknown',
    video_url: record.video_url ?? undefined,
    video_path: record.video_path ?? undefined,
    frames: Number.isFinite(metrics?.frames) ? Math.round(metrics.frames) : undefined,
    duration_s: Number.isFinite(metrics?.duration_s) ? metrics.duration_s : undefined,
    geometry_ok: typeof metrics?.geometry_ok === 'boolean' ? metrics.geometry_ok : undefined,
    degraded: typeof metrics?.degraded === 'boolean' ? metrics.degraded : undefined,
    degrade_reason: metrics?.degrade_reason ?? undefined,
    warnings: [...new Set([...(record.warnings ?? []), ...(record.metrics?.warnings ?? [])])],
    elapsed_s: Number.isFinite(record.elapsed_s) ? record.elapsed_s : undefined,
    error: record.error ?? undefined,
    summary: summaryText(record),
  });
}

/** Recent task params, the input to the "tweak one field" flow. */
function recentTasks(store, limit = 5, owner) {
  return (owner ? store.listForSession(owner, limit) : []).map((record) => compact({
    task_id: record.id,
    status: record.status,
    created_at: record.created_at,
    engine: record.engine,
    params: record.params,
    video_url: record.video_url ?? undefined,
    error: record.error ?? undefined,
  }));
}

/**
 * Wait for a task to settle, honouring the tool call's cancellation signal.
 * A cancelled call stops its render instead of leaving an orphan process.
 */
async function waitSettled(store, record, waitMs, signal) {
  let abortListener;
  const aborted = new Promise((resolve) => {
    if (signal?.aborted) { resolve('aborted'); return; }
    abortListener = () => resolve('aborted');
    signal?.addEventListener('abort', abortListener, { once: true });
  });
  try {
    const outcome = await Promise.race([
      store.waitFor(record, waitMs).then(() => 'settled'),
      aborted,
    ]);
    if (outcome === 'aborted') {
      store.cancel(record, '工具调用被取消（超时或用户中断），渲染已停止。');
    }
    return store.get(record.id) ?? record;
  } finally {
    if (abortListener) signal?.removeEventListener('abort', abortListener);
  }
}

/**
 * Plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config - `cordis.patch.yml` row config.
 */
export function apply(ctx, config = {}) {
  const store = new PreviewStore({ pluginDir, config, logger });
  store.init();

  // Stop the runner with the plugin (HMR reload / profile change).
  ctx.effect(() => () => store.dispose());

  // Live MuJoCo frame workers powering the interactive viewer. One worker at a
  // time: each holds a compiled model + GL renderer (~800 MB), and the viewer is
  // the only consumer. Idle workers die fast so a forgotten tab cannot pin RAM.
  const frames = new FramePool({
    python: store.python,
    assetRoot: store.assetsRoot,
    pluginDir,
    logger,
    idleMs: 45_000,
    maxWorkers: 1,
  });
  store.onSuperseded = (record) => frames.release(record.id);
  ctx.effect(() => () => frames.dispose());

  // ---- HTTP surface for the Browser half ---------------------------------
  const guard = (headers) => {
    try {
      const connection = ctx.get('connection');
      return connection?.requestRejection?.({ headers });
    } catch {
      return undefined;
    }
  };
  const apiHandler = createApiHandler({
    store,
    frames,
    guard,
    logger,
    templates: () => buildTemplates({ recentTasks: recentTasks(store, 5) }),
  });
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: apiHandler,
  }));

  // ---- Agent tools --------------------------------------------------------
  ctx.tools.register({
    name: 'duck_templates',
    description:
      'List the Microduck biped motion-preview templates and the exact `duck_preview` parameter schema, ' +
      'including Chinese synonym hints and the most recent preview tasks with their params. ' +
      'Call this FIRST whenever the user asks for a Microduck/机器人 motion preview in any wording ' +
      '(让它走、往前走、倒退走、走8字、绕圈、画弧、步态预览), and before a parameter tweak such as ' +
      '“步子小一点” or “圈再大一点” so you can reuse the previous params and change one field. ' +
      'Scope: body-locomotion preview only (no ball interaction, no training).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const owner = exec?.agent?.id ? String(exec.agent.id) : undefined;
      return JSON.stringify(buildTemplates({ recentTasks: recentTasks(store, 5, owner) }), null, 2);
    },
  });

  ctx.tools.register({
    name: 'duck_preview',
    description:
      'Generate a Microduck motion for the current session’s MuJoCo Playground. ' +
      'Invoke for a user message beginning with /duck_go (if the host can pass it through); ordinary conversation must not change the motion. ' +
      'Returns task_id, status and metrics; the Playground displays the current action. Video encoding happens only on export. ' +
      'All parameters are optional and default sensibly, so a follow-up tweak may pass only the changed field — ' +
      'but prefer passing the full params from duck_templates.recent_tasks. ' +
      'For a SEQUENCE of moves in one clip (e.g. “往前走，然后向左转弯，再向右转”), use pattern="composite" with ' +
      '`segments`; omitting segments defaults to forward 0.35 m → left 90° → right 90°. ' +
      'For a POSE gesture (standing on one leg, e.g. “单脚悬停”“抬一只脚站着”), use pattern="hover" with ' +
      'hover_foot (which sole lifts), lift_height_m and hold_s. ' +
      'If status is "running", call duck_status(task_id) instead of submitting a duplicate task. ' +
      'Invalid/out-of-range parameters return a human-readable Chinese range error. ' +
      'Scope: body locomotion only (line/arc/figure-8/composite, forward/backward, step length, radius, laps, speed); ' +
      'ball interaction and RL training are out of scope.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          enum: ['line', 'arc', 'figure8', 'composite', 'hover'],
          description: 'Trajectory: line = 直线, arc = 弧线/绕圈, figure8 = 8 字, composite = 分段组合（用 segments）, hover = 原地单脚悬停（用 hover_foot/lift_height_m/hold_s）. Default line.',
        },
        direction: {
          type: 'string',
          enum: ['forward', 'backward'],
          description: 'Walking direction: forward = 前进, backward = 倒退/后退. Default forward.',
        },
        step_length_m: {
          type: 'number',
          description: 'Step length in metres, 0.02–0.06 (default 0.04). “步子小一点” → 0.02–0.03.',
        },
        radius_m: {
          type: 'number',
          description: 'Arc/figure-8 radius in metres, 0.05–0.15 (default 0.09). “圈再大一点” → +0.01–0.02.',
        },
        laps: {
          type: 'number',
          description: 'Laps, 0.5–3 (default 1). arc = circles, figure8 = figure-8s, line = traversals (~0.6 m each).',
        },
        speed: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
          description: 'Tempo: slow = 慢一点, normal = 正常, fast = 快一点. Default normal.',
        },
        hover_foot: {
          type: 'string',
          enum: ['left', 'right'],
          description: 'Only for pattern="hover": the sole that LIFTS (the other one supports). Default right = 抬右脚.',
        },
        lift_height_m: {
          type: 'number',
          description: 'Only for pattern="hover": sole clearance in metres, 0.02–0.08 (default 0.04).',
        },
        hold_s: {
          type: 'number',
          description: 'Only for pattern="hover": how long the lift is held, 0.5–5 s (default 2.5).',
        },
        segments: {
          type: 'array',
          description:
            'Only for pattern="composite": ordered moves in one clip. Each item is either ' +
            '{"kind":"straight","length_m":0.35} or {"kind":"turn","turn_deg":90,"radius_m":0.12} ' +
            '(turn_deg positive = left, negative = right; also accepts kind="left"/"right"); hover uses hover_foot/lift_height_m/hold_s; stand uses hold_s; sidestep uses side/length_m and explicitly degrades to turn then straight. ' +
            'Omit it to get forward 0.35 m → left 90° → right 90°.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: {
              kind: {
                type: 'string',
                enum: ['straight', 'turn', 'left', 'right', 'sidestep', 'hover', 'stand'],
                description: 'straight = 直行（用 length_m）, turn = 按 turn_deg 正负转弯, left/right = 强制左/右转.',
              },
              side: { type: 'string', enum: ['left', 'right'] },
              hover_foot: { type: 'string', enum: ['left', 'right'] },
              lift_height_m: { type: 'number', minimum: 0.02, maximum: 0.08 },
              hold_s: { type: 'number', minimum: 0.5, maximum: 5 },
              length_m: { type: 'number', description: 'Straight length in metres, 0.05–1.5.' },
              turn_deg: { type: 'number', description: 'Turn angle in degrees, ±(0.1–180); positive = left (counter-clockwise).' },
              radius_m: { type: 'number', description: 'Turn radius in metres, 0.06–0.30 (this robot turns reliably at ≥0.10).' },
            },
          },
        },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    timeoutMs: 170_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // Tuning closed loop: fields the model omitted inherit the previous task,
      // so "圈再大一点" can pass only radius_m. Explicit values always win.
      const owner = sessionId(String(exec.agent?.id ?? ''));
      const previous = store.listForSession(owner).find((r) => r.status !== 'error');
      const { merged, inherited } = inheritParams(args, previous?.params);
      const { params, warnings: validationWarnings } = validateInput(merged);
      const warnings = [...validationWarnings];
      if (inherited.length > 0 && previous) {
        warnings.push(
          `未传的字段沿用上一次任务（${previous.id}）：${inherited.join(', ')}。` +
          '如需改回默认值请显式传参。',
        );
      }
      const record = store.create(params, {
        warnings,
        callId: exec.callId ? String(exec.callId) : undefined,
        sessionId: exec.agent?.id ? String(exec.agent.id) : undefined,
      });
      const settled = await waitSettled(store, record, store.waitMs, exec.signal);
      return toolValue(settled);
    },
  });

  ctx.tools.register({
    name: 'duck_status',
    description:
      'Check the status of a Microduck preview task started by duck_preview (returns immediately). ' +
      'Use it when duck_preview returned status "running" — repeat until status is done or error. ' +
      'Returns the same value shape as duck_preview (task_id, status, video path/url, metrics summary, error).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: 'The task_id returned by duck_preview (format 20261027-231500-ab12).',
        },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : '';
      if (!taskId) throw new Error('task_id 不能为空：请传入 duck_preview 返回的 task_id。');
      const record = ownedTask(store, taskId, sessionId(String(exec?.agent?.id ?? '')));
      if (!record) {
        const known = store.list(5).map((item) => item.id);
        throw new Error(
          `找不到任务 ${taskId}。最近的任务：${known.length ? known.join(', ') : '(还没有任务)'}。` +
          '请先调用 duck_preview，或使用 duck_templates 查看最近任务。',
        );
      }
      return toolValue(record);
    },
  });

  // Workbench tools use the same implementations and task recipes as the UI.
  const wbConfig = workbenchConfig(store);
  const ownerOf = (exec) => sessionId(String(exec?.agent?.id ?? ''));
  const structuredOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  const register = (name, description, properties, execute) => ctx.tools.register({ name, description,
    parameters: { type: 'object', properties, additionalProperties: false }, output: structuredOutput,
    timeoutMs: 190000, isConcurrencySafe: () => false,
    async execute(args, exec) { return JSON.stringify(await execute(args, ownerOf(exec))); } });
  register('duck_doctor', 'Inspect runtime assets, interpreter and real reward function signatures; never starts PPO.', {}, () => ({
    python: store.python, assetsRoot: store.assetsRoot, robot_xml: fs.existsSync(path.join(store.assetsRoot, ROBOT_XML_REL)),
    rewards: validateCatalog(wbConfig, true), bam_preflight_available: fs.existsSync(path.join(store.assetsRoot, 'scripts/train_microduck_cpu.py')), engine: store.resolveEngine(),
  }));
  register('duck_rewards', 'List/add/remove/set task-bound reward cards. Only existing training functions; signs and parameter names are validated. Changes create immutable recipe versions, never train.', {
    task_id: { type: 'string' }, action: { type: 'string', enum: ['list', 'add', 'remove', 'set'] }, id: { type: 'string' }, weight: { type: 'number' }, params: { type: 'object' }, active_phases: { type: 'array', items: { type: 'string', enum: ['all', 'walk', 'turn', 'hover', 'stand', 'transition'] } },
  }, (args, owner) => {
    const record = args.task_id ? ownedTask(store, args.task_id, owner) : store.listForSession(owner)[0];
    if (!record) throw new Error('先创建当前对话的动作任务。');
    const p = record.params.pattern;
    if (!args.action || args.action === 'list') return listRewards(wbConfig, owner, p, record.id);
    if (args.action === 'set') return setReward(wbConfig, owner, args.id, args, p, record.id);
    return (args.action === 'add' ? addReward : removeReward)(wbConfig, owner, args.id, p, record.id);
  });
  register('duck_explain', 'Render a cached reference/perturbation clip scored by the actual training callable. Unavailable sensor/torque terms are training_only; never predict a learned policy.', { task_id: { type: 'string' }, id: { type: 'string' } }, async (args, owner) => {
    const record = ownedTask(store, args.task_id, owner); const term = catalogTerm(wbConfig, args.id);
    const selected = listRewards(wbConfig, owner, record.params.pattern, record.id).selection.find((t) => t.id === term.id);
    return explainTerm(wbConfig, record, { ...term, selected });
  });
  register('duck_pack', 'Export motion, commands, enabled rewards, criteria, physical precheck and a hash-bound review. Runs the training repository BAM baseline; reports failures. Does not approve or start PPO.', { task_id: { type: 'string' } }, (args, owner) => packTask(wbConfig, ownedTask(store, args.task_id, owner), owner));
  register('duck_verify', 'Verify an exported pack against artifact, robot, reward-function and tool hashes. Read-only; never approves or starts training.', { pack_id: { type: 'string' } }, (args, owner) => verifyOwnedPack(wbConfig, args.pack_id, owner));

  logger('ready', {
    dataDir: store.tasksDir,
    engine: store.resolveEngine(),
    restoredTasks: store.tasks.size,
  });
}
