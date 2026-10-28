'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('parameter-form');
  const query = new URLSearchParams(location.search);
  const sessionId = query.get('session_id') || sessionStorage.getItem('microduck-session') || crypto.randomUUID();
  sessionStorage.setItem('microduck-session', sessionId);
  const apiPrefix = '/api/microduck';
  const labels = { line: '直线', arc: '绕圈', figure8: '8 字', composite: '多段组合', hover: '单脚悬停', forward: '前进', backward: '倒退', queued: '排队中', running: '渲染中', done: '已完成', error: '失败' };
  let segments = [{ kind: 'straight', length_m: .35 }, { kind: 'turn', turn_deg: 90, radius_m: .12 }, { kind: 'hover', hover_foot: 'right', lift_height_m: .04, hold_s: 2.5 }];
  const state = {
    tasks: [], task: null, taskId: query.get('task_id'), scene: null, mode: 'scene',
    dirty: false, submitting: false, connected: false, followingLatest: query.get('follow') !== 'history',
    camera: { az: 130, el: -18, dist: 0.70, follow: true }, time: 0, duration: 0,
    playing: false, speed: 1, frameDirty: false, frameController: null, objectUrl: null,
    visible: !document.hidden, inViewport: true, version: 0, lastFrameAt: 0, lastTickAt: performance.now(),
    lastHudAt: 0, frameFailed: false, polling: false, pointer: null, schema: null,
  };

  function endpoint(route, values = {}) {
    const url = new URL(`${apiPrefix}${route}`, location.origin);
    url.searchParams.set('session_id', sessionId);
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return `${url.pathname}${url.search}`;
  }

  async function api(route, options = {}) {
    const response = await fetch(endpoint(route), { cache: 'no-store', ...options, headers: { 'content-type': 'application/json', ...options.headers } });
    let body;
    try { body = await response.json(); } catch { throw new Error(`服务返回了无法读取的内容（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return body;
  }

  function notice(id, message) {
    $(id).textContent = message || '';
    $(id).hidden = !message;
  }

  function connection(ok) {
    state.connected = ok;
    $('connection-dot').className = `dot ${ok ? 'connected' : 'failed'}`;
    $('connection-label').textContent = ok ? '本地服务已连接' : '连接中断';
    updateButtons();
  }

  function taskTitle(task) {
    const p = task.params || {};
    const sequence = (p.segments || []).map((v) => ({ straight: `直行 ${v.length_m}m`, turn: `${v.turn_deg > 0 ? '左' : '右'}转 ${Math.abs(v.turn_deg)}°`, hover: `抬${v.hover_foot === 'left' ? '左' : '右'}脚 ${v.hold_s}s`, stand: `站立 ${v.hold_s}s`, sidestep: `${v.side === 'right' ? '右' : '左'}侧移（替代）` })[v.kind]).join(' → ');
    const action = p.pattern === 'composite' ? sequence : p.pattern === 'hover' ? `抬${p.hover_foot === 'left' ? '左' : '右'}脚 · 单脚悬停` : `${labels[p.direction] || '前进'} · ${labels[p.pattern] || p.pattern || '动作'}`;
    const date = new Date(task.created_at);
    const time = Number.isNaN(+date) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return `${action} · ${labels[task.status] || task.status}${time ? ` · ${time}` : ''}`;
  }

  function updateTaskChoices() {
    const select = $('task-select');
    const fragment = document.createDocumentFragment();
    if (!state.tasks.length) fragment.append(new Option('暂无任务', ''));
    for (const task of state.tasks) fragment.append(new Option(taskTitle(task), task.id || task.task_id));
    select.replaceChildren(fragment);
    select.value = state.taskId || '';
  }

  function fillForm(params) {
    for (const [key, value] of Object.entries(params || {})) {
      const element = form.elements.namedItem(key);
      if (element && value !== undefined && value !== null) element.value = key === 'segments' ? JSON.stringify(value, null, 2) : value;
    }
    if (params?.segments) segments = structuredClone(params.segments);
    renderSegments();
    state.dirty = false;
    updatePattern();
    updateEditStatus();
  }

  function updatePattern() {
    const pattern = form.elements.pattern.value;
    $('hover-fields').hidden = pattern !== 'hover';
    $('composite-fields').hidden = pattern !== 'composite';
    const inactive = { 'radius-field': !['arc', 'figure8'].includes(pattern), 'direction-field': pattern === 'hover', 'speed-field': false, 'step-field': pattern === 'hover', 'laps-field': ['hover', 'composite'].includes(pattern) };
    for (const [id, disabled] of Object.entries(inactive)) {
      $(id).classList.toggle('inactive', disabled);
      const input = $(id).querySelector('input,select');
      input.disabled = disabled;
    }
    for (const input of $('hover-fields').querySelectorAll('input,select')) input.disabled = pattern !== 'hover';
    for (const input of $('segments-editor').querySelectorAll('input,select')) input.disabled = pattern !== 'composite';
  }

  function updateEditStatus() {
    $('edit-status').textContent = state.dirty ? '参数已修改 · 生成后生效' : state.task ? '当前任务参数' : '生成新的动作预览';
    $('edit-status').classList.toggle('dirty', state.dirty);
  }

  function updateTaskStatus() {
    const task = state.task;
    const badge = $('engine-badge');
    const geometry = $('geometry-badge');
    if (!task) { badge.textContent = '未生成'; badge.className = 'badge subtle'; geometry.hidden = true; $('task-notes').hidden = true; notice('warning-banner', ''); updateButtons(); return; }
    badge.textContent = task.engine === 'real' ? 'REAL' : task.engine === 'demo' ? 'DEMO' : '未知引擎';
    badge.className = `badge ${task.engine === 'real' ? '' : 'warning'}`;
    const metrics = task.metrics_summary || {};
    geometry.hidden = false;
    if (task.status !== 'done') {
      geometry.textContent = labels[task.status] || task.status;
      geometry.className = `badge ${task.status === 'error' ? 'error' : 'subtle'}`;
    } else if (task.engine === 'demo') {
      geometry.textContent = '示例片段'; geometry.className = 'badge warning';
    } else if (metrics.degraded) {
      geometry.textContent = '轨迹已降级'; geometry.className = 'badge warning';
    } else if (metrics.geometry_ok === true) {
      geometry.textContent = '几何通过'; geometry.className = 'badge';
    } else { geometry.textContent = metrics.geometry_ok === false ? '几何未通过' : '几何未验证'; geometry.className = 'badge warning'; }
    const notes = [...new Set(task.warnings || [])];
    $('notes-list').replaceChildren(...notes.map((message) => { const item = document.createElement('li'); item.textContent = message; return item; }));
    $('notes-count').textContent = `(${notes.length})`;
    $('task-notes').hidden = notes.length === 0;
    const warnings = [];
    // Changes to requested duration or geometry must remain visible, even with collapsed notes.
    warnings.push(...notes.filter((message) => /已截短|已上调|已降低|已缩短|已调整/.test(message)));
    if (task.engine === 'demo') warnings.unshift('DEMO：这是预置示例片段，不是按本次参数生成的动作。');
    if (metrics.degraded) warnings.unshift(`轨迹已降级：${metrics.degrade_reason || '请检查任务指标'}${metrics.effective_pattern ? `；实际轨迹为 ${labels[metrics.effective_pattern] || metrics.effective_pattern}` : ''}。`);
    if (metrics.geometry_ok === false) warnings.unshift('几何检查未通过，请检查任务指标后调整动作参数。');
    notice('warning-banner', [...new Set(warnings)].join('\n'));
    if (task.status === 'error') notice('error-banner', task.error || '动作生成失败，请检查服务日志。');
    const available = task.status === 'done' && Boolean(task.video_url || task.video_path);
    $('video-tab').disabled = !available;
    const download = $('download-button');
    download.classList.toggle('disabled', !available);
    download.setAttribute('aria-disabled', String(!available));
    if (available) {
      download.href = endpoint(`/tasks/${encodeURIComponent(state.taskId)}/video`);
      download.download = `microduck-${state.taskId}.mp4`;
    } else { download.removeAttribute('href'); download.removeAttribute('download'); }
    updateButtons();
  }

  function setEmpty(title, description, show = true) {
    $('empty-title').textContent = title;
    $('empty-description').textContent = description;
    $('empty-state').hidden = !show;
    $('empty-state').querySelector('.suggestion').hidden = Boolean(state.task);
  }

  function updateButtons() {
    const ready = Boolean(state.scene?.interactive) && !state.frameFailed && state.mode === 'scene';
    for (const id of ['play-button', 'timeline', 'reset-camera', 'follow-camera']) $(id).disabled = !ready;
    $('generate-button').disabled = state.submitting || !state.connected;
    $('pack-button').disabled = state.packPending || state.dirty || state.task?.status !== 'done' || state.task?.engine !== 'real';
    $('generate-label').textContent = state.submitting ? '正在提交…' : '生成新预览';
    $('play-icon').setAttribute('href', state.playing ? '#pause' : '#play');
    $('play-button').setAttribute('aria-label', state.playing ? '暂停' : '播放');
  }

  function updateTime() {
    const time = state.time.toFixed(1).padStart(4, '0');
    const duration = state.duration.toFixed(1).padStart(4, '0');
    $('time-label').replaceChildren(document.createTextNode(`${time} `));
    const suffix = document.createElement('span'); suffix.textContent = `/ ${duration} s`; $('time-label').append(suffix);
    $('timeline').value = String(state.time);
    updateCommandLabel();
  }

  function stopPlaying() { state.playing = false; updateButtons(); }
  function revokeFrame() {
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    $('scene-image').removeAttribute('src');
  }
  function abortFrame() { state.frameController?.abort(); state.frameController = null; }
  function release(taskId = state.taskId, beacon = false) {
    if (!taskId) return;
    const url = endpoint('/viewer/release', { task_id: taskId });
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon(url, ''); return; }
    fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  }

  async function selectTask(taskId, { preserveForm = false } = {}) {
    const oldId = state.taskId;
    const version = ++state.version;
    abortFrame(); release(oldId); stopPlaying(); revokeFrame();
    state.command = null; drawCommand(); $('pack-result').hidden = true; $('verify-button').hidden = true; $('reward-cards').replaceChildren();
    state.taskId = taskId; state.task = state.tasks.find((task) => (task.id || task.task_id) === taskId) || null;
    state.scene = null; state.time = 0; state.duration = 0; state.frameFailed = false; state.frameDirty = false; state.mode = 'scene';
    $('scene-image').hidden = true; $('recorded-video').pause(); $('recorded-video').hidden = true;
    $('recorded-video').removeAttribute('src'); $('recorded-video').load();
    $('frame-loading').hidden = true; $('camera-hint').hidden = true; $('viewer-hud').hidden = true;
    $('scene-tab').classList.add('active'); $('video-tab').classList.remove('active');
    $('scene-tab').setAttribute('aria-selected', 'true'); $('video-tab').setAttribute('aria-selected', 'false');
    $('viewport').setAttribute('aria-labelledby', 'scene-tab'); $('scene-controls').hidden = false;
    notice('error-banner', '');
    const url = new URL(location.href); url.searchParams.set('session_id', sessionId);
    url.searchParams.set('follow', state.followingLatest ? 'latest' : 'history');
    if (taskId) url.searchParams.set('task_id', taskId); else url.searchParams.delete('task_id');
    history.replaceState(null, '', url);
    updateTaskChoices(); updateTime(); updateTaskStatus();
    loadRewards().catch((e) => notice('error-banner', e.message));
    if (!taskId) { setEmpty('从一个动作开始', '在 Codex 对话里描述动作，或在下方设置参数。生成后可旋转视角、播放和导出视频。'); return; }
    if (!state.task) {
      try { const task = await api(`/tasks/${encodeURIComponent(taskId)}`); if (version !== state.version) return; state.task = task; }
      catch (error) { if (version === state.version) { notice('error-banner', error.message); setEmpty('无法读取任务', '请确认任务属于当前对话，或选择另一个历史任务。'); } return; }
    }
    if (!preserveForm) fillForm(state.task.params);
    updateTaskStatus();
    if (state.task.status !== 'done') {
      setEmpty(state.task.status === 'error' ? '动作生成失败' : state.task.status === 'queued' ? '等待上一项任务完成' : '正在生成动作', state.task.status === 'error' ? '检查上方错误信息，调整参数后可重新生成。' : '任务将在后台继续，完成后自动加载实时场景。');
      return;
    }
    await loadScene(version);
    loadCommand(version);
  }

  async function loadScene(version = state.version) {
    $('frame-loading').hidden = false;
    setEmpty('正在加载场景', '首次载入需要编译真实 MuJoCo 模型。');
    try {
      const scene = await api(`/tasks/${encodeURIComponent(state.taskId)}/scene`);
      if (version !== state.version) return;
      state.scene = scene;
      if (!scene.interactive || state.task.engine !== 'real') {
        $('frame-loading').hidden = true;
        notice('warning-banner', `${$('warning-banner').textContent}${$('warning-banner').textContent ? '\n' : ''}当前任务没有可交互的真实场景，已切换为录制视频。`);
        switchMode('video'); return;
      }
      state.duration = Number(scene.duration_s) || 0;
      state.camera = { ...state.camera, ...scene.default_camera };
      $('follow-camera').setAttribute('aria-pressed', String(state.camera.follow));
      $('follow-camera').classList.toggle('pressed', state.camera.follow);
      $('timeline').max = String(Math.max(state.duration, .01));
      state.frameDirty = true;
      updateTime(); updateButtons();
    } catch (error) {
      if (version !== state.version) return;
      $('frame-loading').hidden = true;
      notice('error-banner', `实时场景不可用：${error.message}`);
      if (!$('video-tab').disabled) switchMode('video'); else setEmpty('场景暂不可用', '可检查服务日志，或重新生成任务。');
    }
  }

  function switchMode(mode) {
    if (mode === 'video' && $('video-tab').disabled) return;
    state.mode = mode; stopPlaying();
    $('scene-tab').classList.toggle('active', mode === 'scene'); $('video-tab').classList.toggle('active', mode === 'video');
    $('scene-tab').setAttribute('aria-selected', String(mode === 'scene')); $('video-tab').setAttribute('aria-selected', String(mode === 'video'));
    $('viewport').setAttribute('aria-labelledby', `${mode}-tab`);
    $('scene-controls').hidden = mode === 'video';
    $('recorded-video').hidden = mode !== 'video';
    $('camera-hint').hidden = mode !== 'scene' || !state.scene?.interactive;
    $('viewer-hud').hidden = mode !== 'scene' || !state.scene?.interactive;
    $('scene-image').hidden = mode !== 'scene' || !state.objectUrl;
    $('empty-state').hidden = mode === 'video' || Boolean(state.objectUrl);
    $('frame-loading').hidden = true;
    if (mode === 'video') {
      abortFrame(); release();
      $('recorded-video').src = endpoint(`/tasks/${encodeURIComponent(state.taskId)}/video`);
    } else {
      $('recorded-video').pause();
      if (!state.scene?.interactive) setEmpty('实时场景不可用', '当前任务仅提供录制视频。');
      else { state.frameFailed = false; state.frameDirty = true; }
    }
    updateButtons();
  }

  async function renderFrame(now) {
    if (state.frameController || !state.scene?.interactive || state.frameFailed || !state.frameDirty || !state.visible || !state.inViewport || state.mode !== 'scene') return;
    if (now - state.lastFrameAt < 1000 / 24) return;
    const controller = new AbortController(); state.frameController = controller;
    const version = state.version; state.lastFrameAt = now; state.frameDirty = false;
    const camera = state.camera;
    const url = endpoint(`/tasks/${encodeURIComponent(state.taskId)}/frame`, { t: state.time, az: camera.az, el: camera.el, dist: camera.dist, follow: camera.follow ? 1 : 0, w: 720, h: 480, shadows: 0, q: 80 });
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) { const error = await response.json(); throw new Error(error.message || error.error || `HTTP ${response.status}`); }
      const blob = await response.blob();
      if (version !== state.version || controller.signal.aborted) return;
      const old = state.objectUrl; state.objectUrl = URL.createObjectURL(blob);
      $('scene-image').src = state.objectUrl; $('scene-image').hidden = false;
      if (old) URL.revokeObjectURL(old);
      $('empty-state').hidden = true; $('frame-loading').hidden = true; $('camera-hint').hidden = false; $('viewer-hud').hidden = false;
      const ms = response.headers.get('x-mujoco-ms');
      $('render-info').textContent = `MuJoCo${ms ? ` · ${Number(ms).toFixed(0)} ms` : ''}`;
    } catch (error) {
      if (error.name === 'AbortError' || version !== state.version) return;
      state.frameFailed = true; stopPlaying(); $('frame-loading').hidden = true;
      notice('error-banner', `实时帧渲染失败：${error.message}。可切换录制视频查看已生成的结果。`);
      if (!state.objectUrl) setEmpty('实时帧暂不可用', '选择「录制视频」查看结果，或点击「实时场景」重试。');
    } finally {
      if (state.frameController === controller) state.frameController = null;
    }
  }

  function tick(now) {
    const delta = Math.min((now - state.lastTickAt) / 1000, .15); state.lastTickAt = now;
    if (state.playing && state.visible && state.inViewport && state.mode === 'scene') {
      state.time = Math.min(state.duration, state.time + delta * state.speed);
      state.frameDirty = true;
      if (state.time >= state.duration) stopPlaying();
    }
    if (now - state.lastHudAt > 200) { updateTime(); state.lastHudAt = now; }
    renderFrame(now);
    requestAnimationFrame(tick);
  }

  async function refreshTasks() {
    if (state.polling || !state.visible) return;
    state.polling = true;
    try {
      const result = await api('/tasks'); connection(true);
      const tasks = Array.isArray(result) ? result : result.tasks || [];
      const previousStatus = state.task?.status;
      const latestId = tasks[0]?.id || tasks[0]?.task_id;
      state.tasks = tasks;
      if ((!state.taskId || state.followingLatest) && latestId && state.taskId !== latestId && !state.dirty && !state.submitting) {
        await selectTask(latestId); return;
      }
      const current = tasks.find((task) => (task.id || task.task_id) === state.taskId);
      if (current) {
        state.task = current; updateTaskChoices(); updateTaskStatus();
        if (previousStatus !== 'done' && current.status === 'done') { await loadScene(); loadCommand(state.version); loadRewards(); }
        else if (current.status === 'error' && previousStatus !== 'error') setEmpty('动作生成失败', '检查上方错误信息，调整参数后可重新生成。');
      } else updateTaskChoices();
    } catch (error) { connection(false); notice('error-banner', `无法连接本地预览服务：${error.message}。请在 Codex 中重新启动 skill。`); }
    finally { state.polling = false; }
  }

  form.addEventListener('input', () => { state.dirty = true; updatePattern(); updateEditStatus(); updateButtons(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.submitting || !form.reportValidity()) return;
    notice('error-banner', '');
    const params = {};
    for (const [key, value] of new FormData(form)) {
      params[key] = ['step_length_m', 'radius_m', 'laps', 'lift_height_m', 'hold_s'].includes(key) ? Number(value) : value;
    }
    if (params.pattern === 'composite') params.segments = structuredClone(segments);
    state.submitting = true; updateButtons();
    try {
      const task = await api('/preview', { method: 'POST', body: JSON.stringify({ session_id: sessionId, params, ...(state.taskId ? { base_task_id: state.taskId } : {}) }) });
      const taskId = task.task_id || task.id;
      if (!taskId) throw new Error('服务没有返回任务 ID。');
      state.tasks = [task, ...state.tasks.filter((item) => (item.id || item.task_id) !== taskId)];
      state.dirty = false; state.followingLatest = true;
      await selectTask(taskId);
    } catch (error) { notice('error-banner', error.message); }
    finally { state.submitting = false; updateButtons(); }
  });

  $('add-segment').addEventListener('click', () => { if (segments.length >= 6) return; segments.push({ kind: 'stand', hold_s: 1 }); renderSegments(); state.dirty = true; updateEditStatus(); updateButtons(); });

  $('task-select').addEventListener('change', (event) => { state.followingLatest = false; selectTask(event.target.value); });
  $('scene-tab').addEventListener('click', () => switchMode('scene'));
  $('video-tab').addEventListener('click', () => switchMode('video'));
  $('play-button').addEventListener('click', () => {
    if ($('play-button').disabled) return;
    if (!state.playing && state.time >= state.duration) state.time = 0;
    state.playing = !state.playing; state.lastTickAt = performance.now(); updateButtons();
  });
  $('timeline').addEventListener('input', (event) => { stopPlaying(); state.time = Number(event.target.value); state.frameDirty = true; updateTime(); });
  $('playback-speed').addEventListener('change', (event) => { state.speed = Number(event.target.value); });
  $('reset-camera').addEventListener('click', () => { state.camera = { az: 130, el: -18, dist: .70, follow: true, ...state.scene?.default_camera }; state.frameDirty = true; $('follow-camera').setAttribute('aria-pressed', String(state.camera.follow)); $('follow-camera').classList.toggle('pressed', state.camera.follow); });
  $('follow-camera').addEventListener('click', () => { state.camera.follow = !state.camera.follow; state.frameDirty = true; $('follow-camera').setAttribute('aria-pressed', String(state.camera.follow)); $('follow-camera').classList.toggle('pressed', state.camera.follow); });
  $('fullscreen-button').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.viewer-shell').requestFullscreen(); } catch { notice('error-banner', '当前面板不支持全屏，请调整 Codex 侧边面板宽度。'); } });
  const viewport = $('viewport');
  viewport.addEventListener('pointerdown', (event) => {
    if (state.mode !== 'scene' || !state.scene?.interactive || event.button !== 0) return;
    state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!state.pointer || state.pointer.id !== event.pointerId) return;
    state.camera.az = Math.max(-720, Math.min(720, state.camera.az - (event.clientX - state.pointer.x) * .45));
    state.camera.el = Math.max(-89, Math.min(30, state.camera.el + (event.clientY - state.pointer.y) * .3));
    state.pointer.x = event.clientX; state.pointer.y = event.clientY; state.frameDirty = true;
  });
  function finishPointer() { state.pointer = null; viewport.classList.remove('dragging'); }
  viewport.addEventListener('pointerup', finishPointer); viewport.addEventListener('pointercancel', finishPointer); viewport.addEventListener('lostpointercapture', finishPointer);
  viewport.addEventListener('wheel', (event) => {
    if (state.mode !== 'scene' || !state.scene?.interactive) return;
    event.preventDefault(); state.camera.dist = Math.max(.12, Math.min(2.4, state.camera.dist * Math.exp(event.deltaY * .001))); state.frameDirty = true;
  }, { passive: false });
  viewport.addEventListener('keydown', (event) => {
    if (state.mode !== 'scene' || !state.scene?.interactive) return;
    if (event.code === 'Space') { event.preventDefault(); $('play-button').click(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stopPlaying(); state.time = Math.max(0, Math.min(state.duration, state.time + (event.key === 'ArrowRight' ? .1 : -.1))); state.frameDirty = true; updateTime(); }
  });
  document.addEventListener('visibilitychange', () => {
    state.visible = !document.hidden;
    if (!state.visible) { stopPlaying(); abortFrame(); release(); $('recorded-video').pause(); }
    else { state.frameDirty = true; refreshTasks(); }
  });
  const observer = new IntersectionObserver(([entry]) => {
    state.inViewport = entry.isIntersecting;
    if (!state.inViewport) { stopPlaying(); abortFrame(); release(); $('recorded-video').pause(); }
    else state.frameDirty = true;
  });
  observer.observe(viewport);
  window.addEventListener('pagehide', () => { abortFrame(); release(state.taskId, true); revokeFrame(); });
  $('session-label').textContent = `对话 · ${sessionId}`;
  $('session-label').title = sessionId;

  const segmentDefaults = { straight: { length_m: .35 }, turn: { turn_deg: 90, radius_m: .12 }, sidestep: { side: 'left', length_m: .2 }, hover: { hover_foot: 'right', lift_height_m: .04, hold_s: 2.5 }, stand: { hold_s: 1 } };
  const fieldMeta = { length_m: ['距离 m', .05, 1.5, .01], turn_deg: ['转角 °', -180, 180, 1], radius_m: ['半径 m', .06, .3, .01], lift_height_m: ['抬脚 m', .02, .08, .005], hold_s: ['保持 s', .5, 5, .1] };
  function element(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
  function renderSegments() {
    $('segments-editor').replaceChildren(...segments.map((segment, index) => {
      const row = element('div', '', 'segment-row');
      row.append(element('strong', `${index + 1}`));
      const kind = element('select'); kind.setAttribute('aria-label', `分段 ${index + 1} 类型`);
      for (const [value, label] of Object.entries({ straight: '直行', turn: '转弯', sidestep: '侧移（转弯替代）', hover: '单脚悬停', stand: '站立' })) kind.add(new Option(label, value));
      kind.value = segment.kind; kind.addEventListener('change', () => { segments[index] = { kind: kind.value, ...segmentDefaults[kind.value] }; renderSegments(); }); row.append(kind);
      for (const [key, value] of Object.entries(segment)) {
        if (key === 'kind') continue;
        const label = element('label', '', 'field'); let input;
        if (key === 'hover_foot' || key === 'side') {
          label.append(element('span', key === 'side' ? '方向' : '抬起的脚')); input = element('select'); input.add(new Option('左', 'left')); input.add(new Option('右', 'right'));
        } else {
          const [text, min, max, step] = fieldMeta[key]; label.append(element('span', text)); input = element('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.required = true;
        }
        input.value = value; input.setAttribute('aria-label', `分段 ${index + 1} ${key}`);
        input.addEventListener('input', () => { segment[key] = input.tagName === 'SELECT' ? input.value : Number(input.value); });
        label.append(input); row.append(label);
      }
      for (const [text, delta] of [['↑', -1], ['↓', 1], ['删除', 0]]) {
        const b = element('button', text, 'secondary-button'); b.type = 'button'; b.setAttribute('aria-label', `分段 ${index + 1} ${text}`);
        b.disabled = delta ? index + delta < 0 || index + delta >= segments.length : segments.length === 1;
        b.addEventListener('click', () => { if (delta && (index + delta < 0 || index + delta >= segments.length)) return; if (delta) [segments[index], segments[index + delta]] = [segments[index + delta], segments[index]]; else segments.splice(index, 1); renderSegments(); state.dirty = true; updateEditStatus(); updateButtons(); }); row.append(b);
      }
      return row;
    }));
    $('add-segment').disabled = segments.length >= 6;
  }
  async function loadCommand(version) {
    if (!state.taskId || state.task?.engine !== 'real') return;
    try { const command = await api(`/tasks/${state.taskId}/command`); if (version !== state.version) return; state.command = command; drawCommand(); updateCommandLabel(); }
    catch (e) { if (version === state.version) $('command-label').textContent = e.message; }
  }
  function drawCommand() {
    const c = $('command-chart'), ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#d6dfda'; ctx.beginPath(); ctx.moveTo(30, 90); ctx.lineTo(700, 90); ctx.stroke();
    const command = state.command; if (!command) return;
    const duration = command.times.at(-1) || 1;
    for (const [key, color] of [['lin_vel_x', '#25836d'], ['ang_vel_z', '#bd7840']]) {
      const values = command[key]; const limit = Math.max(.05, ...values.map(Math.abs)); ctx.strokeStyle = color; ctx.beginPath();
      values.forEach((v, i) => { const x = 30 + command.times[i] / duration * 670, y = 90 - v / limit * 65; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
      ctx.fillStyle = color; ctx.fillText(`${key === 'lin_vel_x' ? 'vx' : 'wz'} ±${limit.toFixed(2)}`, key === 'lin_vel_x' ? 32 : 170, 18);
    }
    ctx.fillStyle = '#54655e'; ctx.fillText(`0 s`, 30, 175); ctx.fillText(`${duration.toFixed(1)} s`, 650, 175);
  }
  function updateCommandLabel() {
    const c = state.command; if (!c) return;
    const index = Math.min(c.times.length - 1, Math.max(0, Math.round(state.time * c.control_hz)));
    $('command-label').textContent = `${c.stage_label?.[index] || c.phase[index]} · 支撑 ${c.support_foot[index]} · vx ${c.lin_vel_x[index].toFixed(3)} m/s · wz ${c.ang_vel_z[index].toFixed(3)} rad/s`;
  }
  $('command-chart').addEventListener('click', (e) => { if (!state.command) return; const rect = e.currentTarget.getBoundingClientRect(); stopPlaying(); state.time = Math.max(0, Math.min(state.duration, ((e.clientX - rect.left) / rect.width * 720 - 30) / 670 * state.command.times.at(-1))); state.frameDirty = true; updateTime(); });
  async function loadRewards() {
    const version = state.version, taskId = state.taskId;
    const result = await api(`/rewards${taskId ? `?task_id=${encodeURIComponent(taskId)}` : ''}`);
    if (version !== state.version) return;
    state.rewardVersion = result.version;
    $('reward-version').textContent = `版本 ${result.version.slice(0, 8)} · 仅释义 / 未试训`;
    $('reward-cards').replaceChildren(...result.catalog.map((term) => {
      const selected = result.selection.find((t) => t.id === term.id); const card = element('article', '', `reward-card${term.validation?.ok ? '' : ' invalid'}`);
      const title = element('label', '', 'reward-title'), toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = !!selected?.enabled; toggle.disabled = !term.validation?.ok || !taskId;
      title.append(toggle, element('strong', term.label_zh), element('span', term.kind === 'penalty' ? '惩罚 ≤0' : '奖励 ≥0', 'badge subtle')); card.append(title, element('p', term.help, 'field-help'));
      if (!term.validation?.ok) card.append(element('p', term.validation?.error || '函数未验证，不可启用', 'notice error'));
      const inputs = {}, weightLabel = element('label', '', 'field'), weight = element('input'); weight.type = 'range'; weight.min = term.weight.min; weight.max = term.weight.max; weight.step = .01; weight.value = selected?.weight ?? term.weight.default;
      const value = element('output', String(weight.value)); weightLabel.append(element('span', '权重'), weight, value); weight.addEventListener('input', () => { value.textContent = weight.value; }); card.append(weightLabel);
      for (const [key, spec] of Object.entries(term.params || {})) { const label = element('label', '', 'field'), input = element('input'); input.type = 'number'; input.min = spec.min; input.max = spec.max; input.step = 'any'; input.value = selected?.params?.[key] ?? spec.default; input.setAttribute('aria-label', `${term.label_zh} ${key}`); inputs[key] = input; label.append(element('span', key), input); card.append(label); }
      const phase = element('select'); for (const [value, label] of Object.entries({ all: '全时段', walk: '行走', turn: '转弯', hover: '悬停', stand: '站立', transition: '过渡' })) phase.add(new Option(label, value)); phase.value = selected?.active_phases?.[0] || 'all'; phase.setAttribute('aria-label', `${term.label_zh} 生效时段`); card.append(phase);
      const save = element('button', '保存配方', 'secondary-button'), explain = element('button', term.kinematic_evaluable ? '查看释义短片' : '仅训练后可见', 'secondary-button'); save.type = explain.type = 'button'; save.disabled = !term.validation?.ok || !taskId; explain.disabled = !term.validation?.ok || state.task?.status !== 'done' || state.task?.engine !== 'real';
      const mutate = async (action) => { try { await api('/rewards', { method: 'POST', body: JSON.stringify({ task_id: taskId, action, id: term.id, weight: Number(weight.value), params: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, Number(v.value)])), active_phases: [phase.value] }) }); if (taskId === state.taskId) { await loadRewards(); $('pack-result').hidden = true; } } catch (e) { notice('error-banner', e.message); toggle.checked = !!selected?.enabled; } };
      toggle.addEventListener('change', () => mutate(toggle.checked ? 'add' : 'remove')); save.addEventListener('click', () => mutate('set'));
      explain.addEventListener('click', async () => { explain.disabled = true; explain.textContent = '正在调用真实函数并渲染…'; try { const clip = await api(`/tasks/${taskId}/explain`, { method: 'POST', body: JSON.stringify({ id: term.id }) }); card.append(element('p', clip.caption, 'field-help')); if (clip.video_url) { const video = element('video'); video.controls = true; video.src = clip.video_url; card.append(video); } } catch (e) { notice('error-banner', e.message); } finally { explain.disabled = false; explain.textContent = '查看释义'; } });
      card.append(save, explain); return card;
    }));
  }
  $('pack-button').addEventListener('click', async () => {
    const requestedTask = state.taskId, requestedRecipe = state.rewardVersion;
    state.packPending = true; updateButtons(); $('pack-result').hidden = false; $('pack-result').textContent = '正在执行真实 BAM 物理预检，完成后生成审核哈希…';
    try { const result = await api(`/tasks/${requestedTask}/pack`, { method: 'POST', body: '{}' }); if (requestedTask !== state.taskId) return; state.packId = result.pack_id || result.pack_dir.split('/').at(-1); $('verify-button').hidden = false; $('pack-result').textContent = `目录：${result.pack_dir}\n审核版本：${result.review_id}\n${result.handoff_ready ? '等待人工审核；此处未启动训练。' + (result.risks?.length ? '\n风险：' + result.risks.join('；') : '') : '当前阻塞：' + result.handoff.blockers.join('；')}`; if (requestedRecipe !== state.rewardVersion) $('pack-result').textContent += '\n奖励配方在预检期间已变化；此包绑定提交时配方，请重新打包当前版本。'; }
    catch (e) { $('pack-result').textContent = e.message; } finally { state.packPending = false; updateButtons(); }
  });

  $('verify-button').addEventListener('click', async () => { try { const result = await api(`/packs/${state.packId}/verify`); $('pack-result').textContent += `\n版本校验：${result.ok ? '哈希一致' : result.blockers.join('；')}`; } catch (e) { notice('error-banner', e.message); } });

  async function init() {
    renderSegments(); updatePattern(); updateButtons();
    try {
      const catalog = await api('/presets');
      state.schema = catalog.parameter_schema;
      const specs = catalog.parameter_schema?.properties || catalog.parameter_schema || {};
      for (const [name, spec] of Object.entries(specs)) {
        const input = form.elements.namedItem(name);
        if (!input || !spec || typeof spec !== 'object') continue;
        if (spec.minimum !== undefined || spec.min !== undefined) input.min = String(spec.minimum ?? spec.min);
        if (spec.maximum !== undefined || spec.max !== undefined) input.max = String(spec.maximum ?? spec.max);
      }
      if (!state.taskId) fillForm(catalog.last_params || catalog.defaults || {});
      connection(true);
      if (state.taskId) await selectTask(state.taskId);
      await refreshTasks();
      await loadRewards();
    } catch (error) { connection(false); notice('error-banner', `无法启动预览：${error.message}。请在 Codex 中运行 skill 的 doctor / start。`); }
    requestAnimationFrame(tick);
    setInterval(refreshTasks, 2000);
  }
  init();
})();
