/**
 * Browser half of @local/dsh-microduck-preview.
 *
 * Three registration surfaces:
 *  - `main` (key `microduck-preview`)          -> the resident viewer panel
 *  - `sidebar.panellist` (id `microduck-preview`) -> its sidebar icon + new-result badge
 *  - `tool.call.toolview` (key `duck_preview`)  -> inline video card in the chat flow
 *
 * Optional fourth surface: a video renderer for the right Sidebar's document
 * preview, registered only when that plugin's `documentPreviews` service exists.
 *
 * The Client talks to the Host half over same-origin `/api/microduck/*`; the
 * Host route re-applies the Connection trust/cookie fence itself.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-microduck-preview',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/api/microduck';
    const VIEW_ID = 'microduck-preview';
    const LS_SELECTED = 'dsh.microduck.selectedTask.v1';

    const FONT = 'inherit';
    const TEXT = {
      title: 'Microduck Preview',
      subtitle: 'MuJoCo gait preview',
      tasks: 'Tasks',
      params: 'Parameters',
      metrics: 'Metrics',
      empty: 'No preview yet. Ask in chat, for example:',
      emptySamples: ['倒着走 8 字，步子小一点', '绕一个半径 12 厘米的圈', '往前走直线'],
      emptyHint: 'The agent calls duck_templates → duck_preview; the rendered clip appears here.',
      running: 'Rendering in MuJoCo…',
      queued: 'Queued…',
      failed: 'Render failed',
      refresh: 'Refresh',
      download: 'Download mp4',
      openViewer: 'Open viewer',
      allSessions: 'All sessions',
      viewTabHint: 'Open the “Microduck” tab in this session header for the interactive MuJoCo scene.',
      noVideo: 'No video for this task.',
      engineReal: 'REAL pipeline',
      engineDemo: 'DEMO clip',
      geometryOk: 'Geometry check passed',
      geometryDegraded: 'Geometry degraded',
      geometryUnknown: 'Geometry check n/a',
      frames: 'Frames',
      duration: 'Duration',
      elapsed: 'Elapsed',
      step: 'Step length',
      radius: 'Radius',
      laps: 'Laps',
      speed: 'Speed',
      pattern: 'Pattern',
      direction: 'Direction',
      created: 'Created',
      pipeline: 'Pipeline',
      notConnected: 'Cannot reach the preview service',
      // interactive MuJoCo viewer
      sceneTab: 'Live MuJoCo scene',
      recordedTab: 'Recorded mp4',
      play: 'Play',
      pause: 'Pause',
      stepBack: '−1 frame',
      stepFwd: '+1 frame',
      camFollow: 'Follow',
      camFront: 'Front',
      camSide: 'Side',
      camTop: 'Top',
      resetCam: 'Reset view',
      shadows: 'Shadows',
      loadingScene: 'Starting the MuJoCo renderer…',
      sceneFailed: 'Live scene unavailable',
      noMotion: 'This task has no motion data (demo clip) — showing the recorded video instead.',
      time: 'Time',
      frameMs: 'Render',
      sceneHint: 'Drag to orbit · wheel to zoom',
    };

    // ---------------------------------------------------------------- utils --
    let clientCtx = null;
    function service(name) {
      try {
        return clientCtx?.get?.(name);
      } catch {
        return undefined;
      }
    }

    async function fetchJson(url, signal) {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal,
      });
      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json();
          detail = body?.message ?? body?.error ?? '';
        } catch {
          detail = response.statusText;
        }
        throw new Error(`${response.status} ${detail}`.trim());
      }
      return response.json();
    }

    const STATUS_COLOR = {
      done: 'var(--dsw-alias-state-success-primary)',
      running: 'var(--dsw-alias-brand-primary)',
      queued: 'var(--dsw-alias-state-idle-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    };

    const PATTERN_ZH = { line: 'line 直线', arc: 'arc 弧线', figure8: 'figure8 8字', composite: 'composite 复合', hover: 'hover 单脚悬停' };
    const DIRECTION_ZH = { forward: 'forward 前进', backward: 'backward 倒退' };
    const SPEED_ZH = { slow: 'slow 慢', normal: 'normal 常速', fast: 'fast 快' };

    function paramLine(params) {
      if (!params) return '';
      if (params.pattern === 'hover') {
        const foot = params.hover_foot === 'left' ? 'left' : 'right';
        return `hover · ${foot} sole ${((Number(params.lift_height_m) || 0) * 100).toFixed(0)} cm`
          + ` · hold ${params.hold_s}s · ${SPEED_ZH[params.speed] ?? params.speed}`;
      }
      if (params.pattern === 'composite' && Array.isArray(params.segments)) {
        const bits = params.segments.map((seg) => {
          if (seg.kind === 'straight') return `→ ${(Number(seg.length_m) * 100).toFixed(0)} cm`;
          const side = Number(seg.turn_deg) >= 0 ? 'L' : 'R';
          return `${side}${Math.abs(Number(seg.turn_deg)).toFixed(0)}°`;
        });
        return `composite · ${bits.join(' ')} · ${SPEED_ZH[params.speed] ?? params.speed}`;
      }
      const bits = [PATTERN_ZH[params.pattern] ?? params.pattern, DIRECTION_ZH[params.direction] ?? params.direction];
      if (typeof params.step_length_m === 'number') bits.push(`step ${params.step_length_m} m`);
      if (params.pattern !== 'line' && typeof params.radius_m === 'number') bits.push(`r ${params.radius_m} m`);
      bits.push(`laps ${params.laps}`, SPEED_ZH[params.speed] ?? params.speed);
      return bits.join(' · ');
    }

    /** Short human label for one action card / tab (Chinese, like the user speaks). */
    function actionLabel(params) {
      if (!params) return 'preview';
      if (params.pattern === 'hover') {
        const foot = params.hover_foot === 'left' ? '左脚' : '右脚';
        const cm = Math.round((Number(params.lift_height_m) || 0) * 100);
        return `单脚悬停 · ${foot}${cm}cm`;
      }
      if (params.pattern === 'composite' && Array.isArray(params.segments)) {
        const steps = params.segments.map((seg) => (seg.kind === 'straight' ? '直行' : (Number(seg.turn_deg) >= 0 ? '左转' : '右转')));
        return `复合 · ${steps.join('→')}`;
      }
      const dir = params.direction === 'backward' ? '倒退' : '前进';
      const base = { line: '直线', arc: '弧线', figure8: '8字' }[params.pattern] ?? params.pattern;
      const radius = (params.pattern === 'arc' || params.pattern === 'figure8') && typeof params.radius_m === 'number'
        ? ` R${Number(params.radius_m).toFixed(2)}` : '';
      return `${dir}${base}${radius}`;
    }

    function timeLabel(iso) {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch {
        return iso;
      }
    }

    function elapsedSeconds(task) {
      if (!task?.started_at) return 0;
      const end = task.finished_at ? Date.parse(task.finished_at) : Date.now();
      return Math.max(0, Math.round((end - Date.parse(task.started_at)) / 1000));
    }

    function readStorage(key, fallback) {
      try {
        return window.localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* private mode / storage disabled */
      }
    }

    /** Poll the Host task list; fast while a render is running, slow when idle. */
    function useTasks(options = {}) {
      const sessionId = options.sessionId;
      const allSessions = Boolean(options.allSessions);
      const [state, setState] = useState({ data: null, error: null, loading: true });
      const mounted = useRef(true);
      const timer = useRef(null);

      const refresh = useCallback(async () => {
        try {
          const query = sessionId && !allSessions ? `?session_id=${encodeURIComponent(sessionId)}` : '';
          const data = await fetchJson(`${API}/tasks${query}`);
          if (mounted.current) setState({ data, error: null, loading: false });
          return data;
        } catch (error) {
          if (mounted.current) {
            setState((previous) => ({ ...previous, error: String(error?.message ?? error), loading: false }));
          }
          return null;
        }
      }, [sessionId, allSessions]);

      useEffect(() => {
        mounted.current = true;
        let cancelled = false;
        const tick = async () => {
          const data = await refresh();
          if (cancelled) return;
          const busy = (data?.tasks ?? []).some((task) => task.status === 'running' || task.status === 'queued');
          timer.current = setTimeout(tick, busy ? 1200 : 4000);
        };
        tick();
        return () => {
          cancelled = true;
          mounted.current = false;
          if (timer.current) clearTimeout(timer.current);
        };
      }, [refresh]);

      return [state, refresh];
    }

    /** One task's live view, used by the inline chat card (matched by call id). */
    function useTaskByCall(callId, active) {
      const [task, setTask] = useState(null);
      useEffect(() => {
        if (!callId) return undefined;
        let cancelled = false;
        let timer = null;
        const tick = async () => {
          try {
            const data = await fetchJson(`${API}/tasks`);
            if (cancelled) return;
            const match = (data.tasks ?? []).find((item) => item.call_id === callId) ?? null;
            setTask(match);
            const done = match && (match.status === 'done' || match.status === 'error');
            if (!done && active) timer = setTimeout(tick, 1500);
          } catch {
            if (!cancelled && active) timer = setTimeout(tick, 3000);
          }
        };
        tick();
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        };
      }, [callId, active]);
      return task;
    }

    // --------------------------------------------------------------- styles --
    const STYLE_ID = 'microduck-preview-styles';
    function Styles() {
      return h('style', { id: STYLE_ID }, `
        .mduck-root { height: 100%; min-height: 0; display: flex; flex-direction: column;
          background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: ${FONT}; }
        .mduck-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px;
          border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
        .mduck-head-title { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
        .mduck-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); }
        .mduck-spacer { flex: 1; }
        .mduck-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
          background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
          font: inherit; font-size: 12px; padding: 5px 10px; cursor: pointer; }
        .mduck-btn:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
        .mduck-body { flex: 1; min-height: 0; display: flex; }
        .mduck-main { flex: 1; min-width: 0; overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
        .mduck-side { width: 316px; flex: none; border-left: 1px solid var(--dsw-alias-border-l1);
          display: flex; flex-direction: column; min-height: 0; }
        .mduck-side-head { padding: 12px 14px 8px; font-size: 12px; font-weight: 600;
          color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .06em; }
        .mduck-list { overflow: auto; flex: 1; padding: 0 10px 12px; display: flex; flex-direction: column; gap: 6px; }
        .mduck-item { text-align: left; border: 1px solid transparent; border-radius: 9px; padding: 8px 10px;
          background: transparent; color: inherit; font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 3px; }
        .mduck-item:hover { background: var(--dsw-alias-bg-layer-1); }
        .mduck-item-on { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
        .mduck-item-top { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        .mduck-item-params { font-size: 11px; color: var(--dsw-alias-label-secondary);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mduck-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
        .mduck-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
          background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
        .mduck-video { display: block; width: 100%; max-height: min(58vh, 560px); background: #000; }
        .mduck-card-foot { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
          border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; flex-wrap: wrap; }
        .mduck-chip { font-size: 11px; padding: 1px 7px; border-radius: 99px;
          border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
        .mduck-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
        .mduck-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 8px; min-height: 300px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px;
          color: var(--dsw-alias-label-secondary); font-size: 13px; padding: 28px; text-align: center; }
        .mduck-pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--dsw-alias-brand-primary);
          animation: mduck-pulse 1.2s ease-in-out infinite; }
        @keyframes mduck-pulse { 0%,100% { opacity: .25; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
        .mduck-bar { height: 3px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); width: 220px; }
        .mduck-bar > i { display: block; height: 100%; width: 40%; background: var(--dsw-alias-brand-primary);
          animation: mduck-slide 1.4s ease-in-out infinite; }
        @keyframes mduck-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(280%); } }
        .mduck-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 16px;
          font-size: 12px; padding: 12px; }
        .mduck-k { color: var(--dsw-alias-label-secondary); font-size: 11px; }
        .mduck-v { color: var(--dsw-alias-label-primary); }
        .mduck-err { color: var(--dsw-alias-state-error-primary); }
        .mduck-warn { color: var(--dsw-alias-state-warn-primary); }
        .mduck-samples { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
        .mduck-sample { border: 1px solid var(--dsw-alias-border-l1); border-radius: 99px; padding: 3px 10px;
          font-size: 12px; color: var(--dsw-alias-label-secondary); }
        .mduck-toolcard { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
          background: var(--dsw-alias-bg-layer-1); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
          max-width: 560px; font-size: 12px; }
        .mduck-toolcard-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
        .mduck-badge { position: absolute; top: 1px; right: 1px; width: 7px; height: 7px; border-radius: 50%;
          background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px var(--dsw-specific-sidebar-fill); }
        /* action-card tabs (one tab per previewed motion) */
        .mduck-atabs { display: flex; gap: 6px; align-items: flex-end; overflow-x: auto; overflow-y: hidden;
          padding: 8px 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
          background: var(--dsw-alias-bg-base); flex: none; scrollbar-width: thin; }
        .mduck-atab { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; flex: none;
          border: 1px solid var(--dsw-alias-border-l1); border-bottom: none; border-radius: 8px 8px 0 0;
          padding: 6px 10px; margin-bottom: -1px; background: var(--dsw-alias-bg-layer-1);
          color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
        .mduck-atab:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
        .mduck-atab-on { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
          font-weight: 600; border-color: var(--dsw-alias-border-l2); }
        .mduck-atab-label { max-width: 230px; overflow: hidden; text-overflow: ellipsis; }
        .mduck-atab-tag { font-size: 10px; padding: 0 5px; border-radius: 99px;
          border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
        .mduck-atab-empty { padding: 6px 10px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
        /* interactive MuJoCo scene viewer */
        .mduck-tabs { display: flex; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1);
          background: var(--dsw-alias-bg-layer-1); }
        .mduck-tab { appearance: none; border: 1px solid transparent; border-radius: 7px; padding: 4px 10px;
          font: inherit; font-size: 12px; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary); }
        .mduck-tab:hover { color: var(--dsw-alias-label-primary); }
        .mduck-tab-on { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2);
          color: var(--dsw-alias-label-primary); font-weight: 600; }
        .mduck-stage { position: relative; width: 100%; background: #101317; overflow: hidden;
          display: flex; align-items: center; justify-content: center; min-height: 320px; }
        .mduck-stage img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none;
          cursor: grab; touch-action: none; }
        .mduck-stage img:active { cursor: grabbing; }
        .mduck-stage-hud { position: absolute; left: 8px; top: 8px; display: flex; gap: 6px; align-items: center;
          font-size: 11px; color: var(--dsw-alias-label-secondary); background: rgba(10,12,15,.62);
          border-radius: 6px; padding: 3px 8px; }
        .mduck-stage-hint { position: absolute; right: 8px; top: 8px; font-size: 11px;
          color: var(--dsw-alias-label-secondary); background: rgba(10,12,15,.62); border-radius: 6px; padding: 3px 8px; }
        .mduck-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; flex-wrap: wrap;
          border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
        .mduck-toolbar .mduck-spacer { flex: 1; }
        .mduck-timeline { display: flex; align-items: center; gap: 8px; padding: 2px 12px 10px;
          background: var(--dsw-alias-bg-layer-1); font-size: 11px; color: var(--dsw-alias-label-secondary); }
        .mduck-timeline input { flex: 1; accent-color: var(--dsw-alias-brand-primary); }
        .mduck-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
          color: var(--dsw-alias-label-secondary); }
        .mduck-scene-msg { padding: 24px; text-align: center; font-size: 12px;
          color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 8px;
          align-items: center; justify-content: center; min-height: 240px; }
      `);
    }

    // ------------------------------------------------------------ duck mark --
    function DuckMark(props) {
      const size = props.size ?? 16;
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      },
      h('path', { d: 'M20 40c0-9 6-15 14-15 4 0 7 1 9 3l-3 5c-1-1-3-2-5-2-5 0-8 4-8 9 0 2 0 3 1 4H20z', fill: 'currentColor' }),
      h('path', { d: 'M42 25l9-3-2 6 5 1-12 5z', fill: 'var(--dsw-alias-state-warn-primary)' }),
      h('path', { d: 'M24 44c-3 4-3 8-1 11M36 44c2 4 1 8-1 11', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', fill: 'none', opacity: .6 }),
      h('path', { d: 'M18 55h12M32 55h12', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', opacity: .6 }));
    }

    // ------------------------------------------------------- status helpers --
    function statusChip(task) {
      const color = STATUS_COLOR[task.status] ?? STATUS_COLOR.queued;
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color } },
        h('span', { className: 'mduck-dot', style: { background: color } }),
        task.status === 'running' ? 'running' : task.status);
    }

    function engineChip(task) {
      if (!task?.engine) return null;
      const demo = task.engine === 'demo';
      return h('span', {
        className: `mduck-chip${demo ? ' mduck-chip-warn' : ''}`,
        title: task.engine_reason ?? '',
      }, demo ? TEXT.engineDemo : TEXT.engineReal);
    }

    function geometryLine(task) {
      const metrics = task?.metrics_summary;
      if (!task || task.status !== 'done' || !metrics) return null;
      if (metrics.degraded) {
        // A degraded run passed the geometry check but for a DIFFERENT
        // trajectory: lead with that, never with "passed".
        return h('span', { className: 'mduck-warn' },
          `${TEXT.geometryDegraded}: ${metrics.degrade_reason ?? 'trajectory not feasible on this robot'}`);
      }
      if (metrics.geometry_ok === true) {
        const margin = metrics.min_joint_margin_deg;
        return h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } },
          `${TEXT.geometryOk}${typeof margin === 'number' ? ` (min margin ${margin.toFixed(1)}°)` : ''}`);
      }
      return h('span', { className: 'mduck-warn' }, TEXT.geometryUnknown);
    }

    // ------------------------------------------------ live MuJoCo scene ----
    const CAMERA_PRESETS = {
      follow: { az: 130, el: -18, dist: 0.52, follow: true },
      front: { az: 180, el: -8, dist: 0.55, follow: false },
      side: { az: 90, el: -8, dist: 0.55, follow: false },
      top: { az: 90, el: -80, dist: 0.8, follow: false },
    };

    /** One live frame URL: the Host renders it on demand with real MuJoCo. */
    function frameUrl(taskId, opts) {
      const query = new URLSearchParams({
        t: opts.t.toFixed(3),
        az: opts.az.toFixed(1),
        el: opts.el.toFixed(1),
        dist: opts.dist.toFixed(3),
        follow: opts.follow ? '1' : '0',
        lx: (opts.lookat?.[0] ?? 0).toFixed(3),
        ly: (opts.lookat?.[1] ?? 0).toFixed(3),
        w: String(opts.w ?? 900),
        h: String(opts.h ?? 600),
        shadows: opts.shadows ? '1' : '0',
      });
      return `${API}/tasks/${encodeURIComponent(taskId)}/frame?${query.toString()}`;
    }

    /**
     * The interactive viewer: every displayed frame is rendered by MuJoCo on the
     * Host at the requested time and free-camera pose, so dragging the mouse
     * orbits the real scene and the timeline scrubs the authored motion.
     */
    /** Frame size / tempo kept small on purpose: a 900x600 JPEG decoded at 45fps
     *  on the main thread is what made typing in the chat feel frozen. */
    const FRAME_W = 720;
    const FRAME_H = 480;
    const TARGET_FPS = 24;
    const MIN_FRAME_INTERVAL_MS = Math.floor(1000 / TARGET_FPS);

    function SceneViewer(props) {
      const { task, scene } = props;
      const duration = Math.max(0.5, Number(scene?.duration_s) || 1);
      const [playing, setPlaying] = useState(true);
      const [camera, setCamera] = useState(CAMERA_PRESETS.follow);
      const [shadows, setShadows] = useState(false);
      // UI state is published at ~4 Hz; frames themselves never go through React.
      const [ui, setUi] = useState({ t: 0, ms: null, fps: 0, ready: false, error: null });

      const imgRef = useRef(null);
      const stageRef = useRef(null);
      const tRef = useRef(0);
      const camRef = useRef(camera);
      const shadowsRef = useRef(shadows);
      const playRef = useRef(playing);
      const urlRef = useRef(null);
      const busyRef = useRef(false);
      const pendingRef = useRef(false);
      const dragRef = useRef(null);
      const statsRef = useRef({ frames: 0, since: 0, ms: null });
      const uiRef = useRef({ t: 0, ready: false, error: null });
      const visibleRef = useRef(true);
      const liveRef = useRef(true);
      camRef.current = camera;
      shadowsRef.current = shadows;
      playRef.current = playing;

      /** Fetch one frame and paint it straight onto the <img> element. */
      const requestFrame = useCallback(async () => {
        if (!liveRef.current) return;
        if (busyRef.current) { pendingRef.current = true; return; }
        busyRef.current = true;
        try {
          const url = frameUrl(task.id, {
            t: tRef.current % duration,
            ...camRef.current,
            shadows: shadowsRef.current,
            w: FRAME_W,
            h: FRAME_H,
          });
          const response = await fetch(url, { credentials: 'same-origin' });
          if (!response.ok) {
            let message = `${response.status}`;
            try { message = (await response.json()).message ?? message; } catch { /* non-JSON */ }
            uiRef.current.error = message;
            return;
          }
          const ms = Number(response.headers.get('x-mujoco-ms')) || null;
          const blob = await response.blob();
          if (!liveRef.current) return;
          const objectUrl = URL.createObjectURL(blob);
          const previous = urlRef.current;
          urlRef.current = objectUrl;
          const img = imgRef.current;
          if (img) img.src = objectUrl;          // imperative: no re-render
          if (previous) URL.revokeObjectURL(previous);
          uiRef.current.ready = true;
          uiRef.current.error = null;
          const now = performance.now();
          const stats = statsRef.current;
          stats.frames += 1;
          if (!stats.since) stats.since = now;
          stats.ms = ms;
        } catch (error) {
          uiRef.current.error = String(error?.message ?? error);
        } finally {
          busyRef.current = false;
          if (pendingRef.current) {
            pendingRef.current = false;
            if (!playRef.current) requestFrame();
          }
        }
      }, [task.id, duration]);

      // Publish a throttled UI tick so the timeline / HUD / buttons stay in sync
      // without turning every frame into a React update.
      useEffect(() => {
        const timer = setInterval(() => {
          const stats = statsRef.current;
          const now = performance.now();
          let fps = 0;
          if (stats.since) {
            const elapsed = now - stats.since;
            if (elapsed > 500) {
              fps = Math.round((stats.frames * 1000) / elapsed);
              stats.frames = 0;
              stats.since = now;
            }
          }
          setUi((previous) => {
            const next = {
              t: Math.round(tRef.current * 100) / 100,
              ms: stats.ms,
              fps: fps || previous.fps,
              ready: uiRef.current.ready,
              error: uiRef.current.error,
            };
            const same = previous.t === next.t && previous.fps === next.fps
              && previous.ready === next.ready && previous.error === next.error;
            return same ? previous : next;
          });
        }, 250);
        return () => clearInterval(timer);
      }, []);

      // Playback loop, gated on visibility and paced to TARGET_FPS.
      useEffect(() => {
        if (!playing) return undefined;
        let cancelled = false;
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const loop = async () => {
          let last = performance.now();
          while (!cancelled && playRef.current && visibleRef.current) {
            const started = performance.now();
            await requestFrame();
            if (cancelled || !playRef.current) break;
            const now = performance.now();
            const dt = Math.min(0.2, (now - last) / 1000);
            last = now;
            const next = tRef.current + dt;
            if (next >= duration) {
              // One pass through the clip, then rest: no permanent CPU burn.
              tRef.current = duration;
              setPlaying(false);
              break;
            }
            tRef.current = next;
            const rest = MIN_FRAME_INTERVAL_MS - (performance.now() - started);
            if (rest > 0) await sleep(rest);
          }
        };
        loop();
        return () => { cancelled = true; };
      }, [playing, requestFrame, duration]);

      // Paused interaction (drag / scrub / camera / shadows) renders one frame.
      useEffect(() => {
        if (playing || !ui.ready) return undefined;
        const timer = setTimeout(() => requestFrame(), 50);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [playing, camera, shadows, requestFrame]);

      // Stop rendering while the view is hidden or scrolled out of view, and
      // release the MuJoCo worker when the viewer goes away.
      useEffect(() => {
        const stage = stageRef.current;
        const setVisible = (value) => { visibleRef.current = value; };
        const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', onVisibility);
        let observer = null;
        if (stage && typeof IntersectionObserver === 'function') {
          observer = new IntersectionObserver((entries) => {
            setVisible(Boolean(entries[0]?.isIntersecting));
          }, { threshold: 0.01 });
          observer.observe(stage);
        }
        return () => {
          document.removeEventListener('visibilitychange', onVisibility);
          if (observer) observer.disconnect();
          liveRef.current = false;
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = null;
          try {
            fetch(`${API}/viewer/release?task_id=${encodeURIComponent(task.id)}`, {
              method: 'POST', credentials: 'same-origin', keepalive: true,
            }).catch(() => {});
          } catch { /* nothing else to release */ }
        };
      }, [task.id]);

      const setPreset = (name) => {
        setCamera({ ...CAMERA_PRESETS[name], lookat: [0, 0] });
        if (!playing) setTimeout(() => requestFrame(), 0);
      };

      const onPointerDown = (event) => {
        dragRef.current = { x: event.clientX, y: event.clientY, az: camRef.current.az, el: camRef.current.el };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      };
      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const az = drag.az + (event.clientX - drag.x) * 0.45;
        const el = Math.max(-89, Math.min(20, drag.el - (event.clientY - drag.y) * 0.35));
        setCamera((previous) => ({ ...previous, az, el }));
      };
      const onPointerUp = (event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      };
      const onWheel = (event) => {
        event.preventDefault?.();
        setCamera((previous) => ({
          ...previous,
          dist: Math.max(0.12, Math.min(2.4, previous.dist * Math.exp(event.deltaY * 0.0012))),
        }));
      };

      const scrub = (seconds) => {
        setPlaying(false);
        tRef.current = Math.max(0, Math.min(duration, seconds));
        setUi((previous) => ({ ...previous, t: tRef.current }));
        setTimeout(() => requestFrame(), 30);
      };
      const stepFrame = (delta) => scrub(tRef.current + delta);
      const togglePlay = () => {
        const next = !playing;
        if (next && tRef.current >= duration - 0.02) scrub(0);
        setPlaying(next);
      };

      return h('div', null,
        h('div', { className: 'mduck-stage', ref: stageRef },
          h('img', {
            ref: imgRef,
            alt: 'MuJoCo scene frame',
            draggable: false,
            style: { opacity: ui.ready ? 1 : 0 },
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
            onWheel,
          }),
          !ui.ready
            ? h('div', { className: 'mduck-scene-msg', style: { position: 'absolute', inset: 0 } },
              h('div', { className: 'mduck-pulse' }),
              h('div', null, ui.error ?? TEXT.loadingScene))
            : null,
          ui.error && ui.ready ? h('div', { className: 'mduck-stage-hud mduck-err' }, ui.error) : null,
          h('div', { className: 'mduck-stage-hud' },
            h('span', { className: 'mduck-dot', style: { background: 'var(--dsw-alias-state-success-primary)' } }),
            `real MuJoCo · ${FRAME_W}×${FRAME_H}${ui.ms ? ` · ${ui.ms} ms` : ''}${ui.fps ? ` · ${ui.fps} fps` : ''}`),
          h('div', { className: 'mduck-stage-hint' }, TEXT.sceneHint)),
        h('div', { className: 'mduck-toolbar' },
          h('button', { className: 'mduck-btn', type: 'button', onClick: togglePlay },
            playing ? TEXT.pause : TEXT.play),
          h('button', { className: 'mduck-btn', type: 'button', onClick: () => stepFrame(-1 / 25) }, TEXT.stepBack),
          h('button', { className: 'mduck-btn', type: 'button', onClick: () => stepFrame(1 / 25) }, TEXT.stepFwd),
          h('span', { className: 'mduck-spacer' }),
          h('button', { className: 'mduck-btn', type: 'button', onClick: () => setPreset('follow') }, TEXT.camFollow),
          h('button', { className: 'mduck-btn', type: 'button', onClick: () => setPreset('front') }, TEXT.camFront),
          h('button', { className: 'mduck-btn', type: 'button', onClick: () => setPreset('side') }, TEXT.camSide),
          h('button', { className: 'mduck-btn', type: 'button', onClick: () => setPreset('top') }, TEXT.camTop),
          h('label', { className: 'mduck-toggle' },
            h('input', {
              type: 'checkbox', checked: shadows,
              onChange: (event) => setShadows(event.target.checked),
            }), TEXT.shadows)),
        h('div', { className: 'mduck-timeline' },
          h('span', null, `${ui.t.toFixed(2)} s / ${duration.toFixed(2)} s`),
          h('input', {
            type: 'range', min: 0, max: duration, step: 0.02, value: ui.t,
            onChange: (event) => scrub(Number(event.target.value)),
          })));
    }

    /** Stage = tabs between the live scene and the recorded mp4. */
    function Stage(props) {
      const { task } = props;
      const [tab, setTab] = useState('scene');
      const [scene, setScene] = useState(null);
      const [sceneError, setSceneError] = useState(null);

      useEffect(() => {
        let cancelled = false;
        if (task.status !== 'done') return undefined;
        fetchJson(`${API}/tasks/${encodeURIComponent(task.id)}/scene`)
          .then((data) => { if (!cancelled) setScene(data); })
          .catch((error) => {
            if (!cancelled) {
              setScene({ interactive: false });
              setSceneError(String(error?.message ?? error));
            }
          });
        return () => { cancelled = true; };
      }, [task.id, task.status]);

      const interactive = scene?.interactive === true;
      useEffect(() => {
        if (scene && !interactive) setTab('video');
        if (scene?.interactive) setTab('scene');
      }, [scene?.interactive]);

      const tabs = h('div', { className: 'mduck-tabs' },
        h('button', {
          type: 'button', className: `mduck-tab${tab === 'scene' ? ' mduck-tab-on' : ''}`,
          disabled: !interactive && Boolean(scene),
          onClick: () => setTab('scene'),
        }, `${TEXT.sceneTab}${interactive ? '' : scene ? ' —' : ' …'}`),
        h('button', {
          type: 'button', className: `mduck-tab${tab === 'video' ? ' mduck-tab-on' : ''}`,
          onClick: () => setTab('video'),
        }, TEXT.recordedTab));

      let body;
      if (task.status !== 'done') body = h(VideoCard, { task, tall: true });
      else if (tab === 'video') body = h(VideoCard, { task, tall: true });
      else if (scene === null) body = h('div', { className: 'mduck-scene-msg' }, h('div', { className: 'mduck-pulse' }), TEXT.loadingScene);
      else if (!interactive) {
        body = h('div', { className: 'mduck-scene-msg' },
          h(DuckMark, { size: 20 }),
          h('div', { className: 'mduck-warn' }, TEXT.noMotion),
          sceneError ? h('div', { className: 'mduck-err', style: { fontSize: 11 } }, sceneError) : null);
      } else body = h(SceneViewer, { task, scene });

      return h('div', { className: 'mduck-card' }, tabs, body,
        h('div', { className: 'mduck-card-foot' },
          statusChip(task),
          engineChip(task),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, paramLine(task.params)),
          h('span', { className: 'mduck-spacer' }),
          task.video_url
            ? h('a', { className: 'mduck-btn', style: { textDecoration: 'none' }, href: task.video_url, download: `${task.id}.mp4` }, TEXT.download)
            : null));
    }

    // ----------------------------------------------------------- video card --
    function VideoCard(props) {
      const { task, tall } = props;
      if (!task) return null;
      if (task.status === 'done' && task.video_url) {
        return h('div', { className: 'mduck-card' },
          h('video', {
            className: 'mduck-video',
            key: task.id,
            src: task.video_url,
            controls: true,
            autoPlay: true,
            muted: true,
            loop: true,
            playsInline: true,
            style: tall ? undefined : { maxHeight: 320 },
          }),
          h('div', { className: 'mduck-card-foot' },
            statusChip(task),
            engineChip(task),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, paramLine(task.params)),
            h('span', { className: 'mduck-spacer' }),
            h('a', {
              className: 'mduck-btn',
              style: { textDecoration: 'none' },
              href: task.video_url,
              download: `${task.id}.mp4`,
            }, TEXT.download)));
      }
      if (task.status === 'error') {
        return h('div', { className: 'mduck-card', style: { padding: 14, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600 } },
            h(DuckMark, { size: 16 }), TEXT.failed),
          h('div', { className: 'mduck-err', style: { whiteSpace: 'pre-wrap', fontSize: 12 } },
            task.error ?? 'unknown error'),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            'The agent can retry with adjusted parameters or report the failure reason to the user.'));
      }
      return h('div', { className: 'mduck-placeholder' },
        h('div', { className: 'mduck-pulse' }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(DuckMark, { size: 18 }),
          h('span', null, task.status === 'queued' ? TEXT.queued : TEXT.running)),
        h('div', { className: 'mduck-bar' }, h('i')),
        h('div', { style: { fontSize: 12 } }, paramLine(task.params)),
        h('div', { style: { fontSize: 11 } },
          `${TEXT.elapsed}: ${elapsedSeconds(task)} s · task ${task.id}`));
    }

    // -------------------------------------------------------- params + meta --
    function ParamsPanel(props) {
      const task = props.task;
      if (!task) return null;
      const params = task.params ?? {};
      const metrics = task.metrics_summary;
      const rows = [
        [TEXT.pattern, PATTERN_ZH[params.pattern] ?? params.pattern],
        [TEXT.direction, DIRECTION_ZH[params.direction] ?? params.direction],
        [TEXT.step, `${params.step_length_m} m`],
        [TEXT.radius, params.pattern === 'line' ? '—' : `${params.radius_m} m`],
        [TEXT.laps, String(params.laps)],
        [TEXT.speed, SPEED_ZH[params.speed] ?? params.speed],
      ];
      const metricRows = [];
      if (metrics) {
        if (metrics.frames) metricRows.push([TEXT.frames, String(metrics.frames)]);
        if (metrics.duration_s) metricRows.push([TEXT.duration, `${metrics.duration_s} s`]);
        if (typeof metrics.geometry_ok === 'boolean') {
          metricRows.push(['geometry', metrics.geometry_ok ? (metrics.degraded ? 'degraded' : 'ok') : 'unknown']);
        }
      }
      if (task.elapsed_s) metricRows.push([TEXT.elapsed, `${task.elapsed_s} s`]);
      metricRows.push([TEXT.created, timeLabel(task.created_at)]);
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'mduck-card' },
          h('div', { style: { padding: '10px 12px 0', fontSize: 12, fontWeight: 600 } }, TEXT.params),
          h('div', { className: 'mduck-grid' },
            rows.map(([key, value]) => h('div', { key },
              h('div', { className: 'mduck-k' }, key),
              h('div', { className: 'mduck-v' }, String(value ?? '—')))))),
        h('div', { className: 'mduck-card' },
          h('div', { style: { padding: '10px 12px 0', fontSize: 12, fontWeight: 600 } }, TEXT.metrics),
          h('div', { className: 'mduck-grid' },
            metricRows.map(([key, value]) => h('div', { key },
              h('div', { className: 'mduck-k' }, key),
              h('div', { className: 'mduck-v' }, value)))),
          h('div', { style: { padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 4 } },
            geometryLine(task),
            (task.warnings ?? []).map((warning, index) =>
              h('div', { key: `w${index}`, className: 'mduck-warn', style: { fontSize: 11 } }, `⚠ ${warning}`)))));
    }

    // ----------------------------------------------------------------- panel --
    /**
     * The Session View: registered into `conversation.view`, so it appears as a
     * View tab in this Session's header next to Chat / Trajectory. It shows the
     * live MuJoCo scene for previews requested from *this* session.
     */
    // Identical workbench assets are served by both hosts, preserving DSH auth.
    function SessionView(props) {
      const owner = props.sessionId ?? props.session?.id;
      const request = props.viewRequest;
      let taskId = request?.task_id;
      if (!owner) return h('div', { className: 'mduck-workbench', style: { color: 'var(--dsw-alias-label-primary)' } }, h(Styles), h('p', null, '请先打开一个对话。'));
      const params = new URLSearchParams({ session_id: String(owner) });
      if (taskId) params.set('task_id', taskId);
      return h('div', { className: 'mduck-workbench', style: { height: '100%', color: 'var(--dsw-alias-label-primary)' } }, h(Styles), h('iframe', { title: 'Microduck 动作工作台', src: `/api/microduck/workbench/?${params}`, style: { border: 0, width: '100%', height: '100%', minHeight: 800 }, allow: 'fullscreen' }));
    }

    // ------------------------------------------------------------ tool card --
    function DuckToolCard(props) {
      const { callId, phase } = props;
      const task = useTaskByCall(callId, phase !== 'result');
      const label = task?.status === 'done'
        ? `Preview ready · ${paramLine(task.params)}`
        : task?.status === 'error'
          ? 'Preview failed'
          : `Rendering preview… ${task ? `${elapsedSeconds(task)} s` : ''}`;
      return h('div', { className: 'mduck-toolcard', style: { fontFamily: FONT } },
        h(Styles),
        h('div', { className: 'mduck-toolcard-head' },
          h(DuckMark, { size: 15 }),
          h('span', null, 'Microduck preview'),
          h('span', { className: 'mduck-spacer' }),
          task ? statusChip(task) : null),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, label),
        task && (task.status === 'done' || task.status === 'error')
          ? null
          : h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', { className: 'mduck-pulse' }), 'MuJoCo is rendering the requested motion (1–3 min)…'),
        task && task.status === 'done'
          ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, TEXT.viewTabHint)
          : null);
    }

    // ------------------------------------------- right sidebar mp4 preview --
    function VideoDocument(props) {
      const address = props?.resourceAddress ?? '';
      const match = /\/tasks\/([^/]+)\/preview\.mp4$/.exec(String(address));
      if (!match) {
        return h('div', { style: { padding: 16, fontFamily: FONT, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } },
          'This video is not owned by Microduck Preview.');
      }
      const taskId = match[1];
      return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
        h(Styles),
        h('video', {
          src: `${API}/tasks/${encodeURIComponent(taskId)}/video`,
          controls: true, autoPlay: true, muted: true, loop: true, playsInline: true,
          style: { width: '100%', background: '#000', borderRadius: 8 },
        }),
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontFamily: FONT } },
          `Microduck preview · task ${taskId}`),
        h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, TEXT.viewTabHint));
    }

    // --------------------------------------------------------------- plugin --
    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx;

        // The plugin's primary surface: a per-Session Conversation View, i.e. a
        // View tab beside Chat / Trajectory in this Session's header. It owns the
        // live MuJoCo scene for previews requested from this session.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: VIEW_ID,
          order: 20,
          label: 'Microduck',
        }, SessionView));

        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'duck_preview',
        }, DuckToolCard));

        // Optional: teach the right Sidebar's document preview to play our mp4s.
        try {
          ctx.inject(['documentPreviews'], (scoped) => {
            try {
              const previews = scoped.documentPreviews ?? scoped.get('documentPreviews');
              if (!previews || typeof previews.register !== 'function') return;
              scoped.effect(() => previews.register({
                id: 'microduck-video',
                extensions: ['.mp4', '.webm'],
                binaryExtensions: ['.mp4', '.webm'],
                priority: 10,
                title: 'Video',
                loading: 'renderer',
              }));
              scoped.slots.inject('sidebar.right.tab.document', () => scoped.slots.register({
                name: 'sidebar.right.tab.document',
                key: 'microduck-video',
              }, VideoDocument));
            } catch (error) {
              console.warn('[microduck-preview] document preview registration skipped', error);
            }
          });
        } catch (error) {
          console.warn('[microduck-preview] documentPreviews service unavailable', error);
        }
      },
    };
  },
});
