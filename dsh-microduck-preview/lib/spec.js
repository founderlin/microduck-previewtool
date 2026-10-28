/**
 * Model-facing motion catalogue and parameter validation for `duck_preview`.
 *
 * This module is pure data + pure functions: it never touches the filesystem or
 * a subprocess, so the tools and the HTTP presets route can share it.
 */

/** How many decimal places a param is echoed with in summaries. */
const fmt = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(3));

/** Canonical parameter order; also the order used in rendering summaries. */
export const PARAM_ORDER = ['pattern', 'direction', 'step_length_m', 'radius_m', 'laps', 'speed'];

/**
 * One entry per accepted parameter. `min`/`max`/`values` are the real contract;
 * defaults keep every field optional so tuning one field is a small call.
 */
export const PARAM_SPEC = {
  pattern: {
    type: 'enum',
    values: ['line', 'arc', 'figure8', 'composite', 'hover'],
    default: 'line',
    zh: '轨迹形状',
    en: 'trajectory shape',
    help: 'line = 直线；arc = 弧线/绕圈；figure8 = 8 字；composite = 多段组合（用 segments）；hover = 原地单脚悬停（用 hover_foot / lift_height_m / hold_s）',
  },
  direction: {
    type: 'enum',
    values: ['forward', 'backward'],
    default: 'forward',
    zh: '方向',
    en: 'walking direction',
    help: 'forward = 前进；backward = 倒退/后退',
  },
  step_length_m: {
    type: 'number',
    min: 0.02,
    max: 0.06,
    default: 0.04,
    unit: 'm',
    zh: '步长',
    en: 'step length',
    help: 'smaller step = “步子小一点”；0.02–0.03 是很小的步子',
  },
  radius_m: {
    type: 'number',
    min: 0.05,
    max: 0.15,
    default: 0.09,
    unit: 'm',
    zh: '半径',
    en: 'turn radius',
    help: 'arc/figure8 才用；bigger radius = “圈再大一点”',
  },
  laps: {
    type: 'number',
    min: 0.5,
    max: 3,
    default: 1,
    zh: '圈数',
    en: 'laps',
    help: 'arc = 圈数, figure8 = 8 字个数, line = 直线趟数（1 趟约 0.6 m）',
  },
  speed: {
    type: 'enum',
    values: ['slow', 'normal', 'fast'],
    default: 'normal',
    zh: '速度',
    en: 'speed',
    help: 'slow = 慢一点；normal = 正常；fast = 快一点',
  },
  segments: {
    type: 'segments',
    default: null,
    zh: '分段轨迹',
    en: 'segments',
    help: '仅 composite 使用：直行 / 转弯 / 侧移（降级为转弯+直行）/ 悬停 / 站立保持 的时间轴',
  },
  hover_foot: {
    type: 'enum',
    values: ['left', 'right'],
    default: 'right',
    zh: '抬起的那只脚',
    en: 'lifted foot',
    help: '仅 hover 使用：right = 抬右脚；left = 抬左脚',
  },
  lift_height_m: {
    type: 'number',
    min: 0.02,
    max: 0.08,
    default: 0.04,
    unit: 'm',
    zh: '抬脚高度',
    en: 'lift height',
    help: '仅 hover 使用：鞋底离地高度，0.02–0.08 m（默认 0.04，余量最稳）',
  },
  hold_s: {
    type: 'number',
    min: 0.5,
    max: 5,
    default: 2.5,
    unit: 's',
    zh: '保持时长',
    en: 'hold seconds',
    help: '仅 hover 使用：抬起后保持多久',
  },
};

/**
 * Default composite trajectory: forward, then a 90° left turn, then a 90° right
 * turn — exactly the shape behind a sentence such as
 * “鸭子往前走，然后向左转弯，再向右转”.
 */
export const DEFAULT_SEGMENTS = [
  { kind: 'straight', length_m: 0.35 },
  { kind: 'turn', turn_deg: 90, radius_m: 0.12 },
  { kind: 'turn', turn_deg: -90, radius_m: 0.12 },
];

/** Bounds for one composite segment. */
const SEGMENT_LIMITS = {
  maxSegments: 6,
  straight: { min: 0.05, max: 1.5 },
  turnDeg: { min: 0.1, max: 180 },
  turnRadius: { min: 0.06, max: 0.3 },
  hoverLift: { min: 0.02, max: 0.08 },
  hold: { min: 0.5, max: 5 },
};

const PATTERN_FIELDS = {
  line: ['pattern', 'direction', 'step_length_m', 'laps', 'speed'],
  arc: ['pattern', 'direction', 'step_length_m', 'radius_m', 'laps', 'speed'],
  figure8: ['pattern', 'direction', 'step_length_m', 'radius_m', 'laps', 'speed'],
  composite: ['pattern', 'direction', 'step_length_m', 'speed', 'segments'],
  hover: ['pattern', 'speed', 'hover_foot', 'lift_height_m', 'hold_s'],
};

export function fieldsForPattern(pattern) {
  return PATTERN_FIELDS[pattern] ?? PARAM_ORDER;
}

/** Chinese (and English spelling) synonyms the tool normalises before validating. */
const SYNONYMS = {
  pattern: new Map([
    ['line', 'line'], ['straight', 'line'], ['直线', 'line'], ['直走', 'line'], ['走直线', 'line'],
    ['直线行走', 'line'], ['直', 'line'],
    ['arc', 'arc'], ['circle', 'arc'], ['curve', 'arc'], ['弧线', 'arc'], ['圆弧', 'arc'],
    ['绕圈', 'arc'], ['画圆', 'arc'], ['转圈', 'arc'], ['曲线', 'arc'], ['弧', 'arc'],
    ['figure8', 'figure8'], ['figure_8', 'figure8'], ['figure-8', 'figure8'], ['8字', 'figure8'],
    ['八字', 'figure8'], ['绕8字', 'figure8'], ['画8字', 'figure8'], ['8字形', 'figure8'],
    ['八字形', 'figure8'], ['figure 8', 'figure8'], ['infinity', 'figure8'],
  ]),
  direction: new Map([
    ['forward', 'forward'], ['前进', 'forward'], ['向前', 'forward'], ['往前', 'forward'],
    ['正走', 'forward'], ['正常方向', 'forward'], ['前', 'forward'],
    ['backward', 'backward'], ['backwards', 'backward'], ['reverse', 'backward'],
    ['倒退', 'backward'], ['后退', 'backward'], ['倒着走', 'backward'], ['倒走', 'backward'],
    ['反向', 'backward'], ['后', 'backward'],
  ]),
  speed: new Map([
    ['slow', 'slow'], ['慢', 'slow'], ['慢一点', 'slow'], ['慢速', 'slow'], ['慢点', 'slow'],
    ['normal', 'normal'], ['正常', 'normal'], ['中速', 'normal'], ['一般', 'normal'],
    ['fast', 'fast'], ['快', 'fast'], ['快一点', 'fast'], ['快速', 'fast'], ['快点', 'fast'],
  ]),
  hover_foot: new Map([
    ['left', 'left'], ['左脚', 'left'], ['左', 'left'], ['left foot', 'left'], ['l', 'left'],
    ['right', 'right'], ['右脚', 'right'], ['右', 'right'], ['right foot', 'right'], ['r', 'right'],
  ]),
};

/** Human-readable range/description for one spec entry. */
function describeRange(spec) {
  if (spec.type === 'enum') return `${spec.values.join(' | ')}`;
  if (spec.type === 'segments') return '直行 / 转弯 / 侧移 / 悬停 / 站立 的序列（最多 6 段）';
  const unit = spec.unit ? ` ${spec.unit}` : '';
  return `${spec.min}–${spec.max}${unit}`;
}

/** Normalise one composite segment (accepts left/right shorthands). */
function normalizeSegment(entry, index) {
  const label = `segments[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(
      `${label} 必须是对象，例如 {"kind":"turn","turn_deg":90,"radius_m":0.12} 或 {"kind":"straight","length_m":0.35}。`,
    );
  }
  const rawKind = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
  const args = { ...entry };
  delete args.kind;

  if (rawKind === 'straight' || rawKind === 'line' || rawKind === '直行' || rawKind === '前进') {
    const allowed = ['length_m', 'distance_m'];
    const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknown.length) {
      throw new Error(`${label}（直行）不支持字段：${unknown.join(', ')}。只允许 ${allowed.join(' / ')}。`);
    }
    const length = Number(args.length_m ?? args.distance_m ?? 0.35);
    if (!Number.isFinite(length)) throw new Error(`${label}.length_m 必须是数字。`);
    const { min, max } = SEGMENT_LIMITS.straight;
    if (length < min || length > max) {
      throw new Error(
        `${label}.length_m=${length} 超出范围 ${min}–${max} m。想走更远就分成多段直行，单次预览总长度建议 ≤1.6 m。`,
      );
    }
    return { kind: 'straight', length_m: Math.round(length * 1000) / 1000 };
  }

  const turnKind = rawKind === 'left' || rawKind === 'turn_left' || rawKind === '左转'
    ? 'left'
    : rawKind === 'right' || rawKind === 'turn_right' || rawKind === '右转'
      ? 'right'
      : rawKind === 'turn' || rawKind === '转弯' || rawKind === '转向'
        ? 'turn'
        : '';
  if (rawKind === 'hover' || rawKind === '悬停' || rawKind === '单脚' || rawKind === '单脚悬停') {
    const allowed = ['hover_foot', 'foot', 'lift_height_m', 'hold_s'];
    const unknownHover = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknownHover.length) {
      throw new Error(`${label}（悬停）不支持字段：${unknownHover.join(', ')}。只允许 ${allowed.join(' / ')}。`);
    }
    const foot = normalizeEnum('hover_foot', args.hover_foot ?? args.foot ?? 'right');
    if (!PARAM_SPEC.hover_foot.values.includes(foot)) {
      throw new Error(`${label}.hover_foot 必须是 left 或 right。`);
    }
    const lift = Number(args.lift_height_m ?? PARAM_SPEC.lift_height_m.default);
    const hold = Number(args.hold_s ?? PARAM_SPEC.hold_s.default);
    if (!Number.isFinite(lift) || lift < SEGMENT_LIMITS.hoverLift.min || lift > SEGMENT_LIMITS.hoverLift.max) {
      throw new Error(`${label}.lift_height_m 超出范围 ${SEGMENT_LIMITS.hoverLift.min}–${SEGMENT_LIMITS.hoverLift.max} m。`);
    }
    if (!Number.isFinite(hold) || hold < SEGMENT_LIMITS.hold.min || hold > SEGMENT_LIMITS.hold.max) {
      throw new Error(`${label}.hold_s 超出范围 ${SEGMENT_LIMITS.hold.min}–${SEGMENT_LIMITS.hold.max} s。`);
    }
    return {
      kind: 'hover',
      hover_foot: foot,
      lift_height_m: Math.round(lift * 1000) / 1000,
      hold_s: Math.round(hold * 100) / 100,
    };
  }

  if (rawKind === 'stand' || rawKind === '站立' || rawKind === '保持' || rawKind === '站住') {
    const allowed = ['hold_s'];
    const unknownStand = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknownStand.length) {
      throw new Error(`${label}（站立）不支持字段：${unknownStand.join(', ')}。只允许 hold_s。`);
    }
    const hold = Number(args.hold_s ?? 1);
    if (!Number.isFinite(hold) || hold < SEGMENT_LIMITS.hold.min || hold > SEGMENT_LIMITS.hold.max) {
      throw new Error(`${label}.hold_s 超出范围 ${SEGMENT_LIMITS.hold.min}–${SEGMENT_LIMITS.hold.max} s。`);
    }
    return { kind: 'stand', hold_s: Math.round(hold * 100) / 100 };
  }

  if (rawKind === 'sidestep' || rawKind === '侧移' || rawKind === '横移') {
    const allowed = ['side', 'length_m', 'distance_m'];
    const unknownSide = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknownSide.length) {
      throw new Error(`${label}（侧移）不支持字段：${unknownSide.join(', ')}。只允许 ${allowed.join(' / ')}。`);
    }
    const sideRaw = String(args.side ?? 'left').trim().toLowerCase();
    if (!['left', 'right', '左', '右'].includes(sideRaw)) throw new Error(`${label}.side 必须是 left 或 right。`);
    const side = sideRaw === 'right' || sideRaw === '右' ? 'right' : 'left';
    const length = Number(args.length_m ?? args.distance_m ?? 0.2);
    const { min, max } = SEGMENT_LIMITS.straight;
    if (!Number.isFinite(length) || length < min || length > max) {
      throw new Error(`${label}.length_m 超出范围 ${min}–${max} m。`);
    }
    return { kind: 'sidestep', side, length_m: Math.round(length * 1000) / 1000 };
  }

  if (!turnKind) {
    throw new Error(
      `${label}.kind=${JSON.stringify(entry.kind)} 无法识别。允许：straight | turn | left | right | sidestep | hover | stand。`,
    );
  }
  const allowed = ['turn_deg', 'deg', 'angle_deg', 'radius_m', 'radius'];
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`${label}（转弯）不支持字段：${unknown.join(', ')}。只允许 ${allowed.join(' / ')}。`);
  }
  let deg = Number(args.turn_deg ?? args.deg ?? args.angle_deg ?? 90);
  if (!Number.isFinite(deg)) throw new Error(`${label}.turn_deg 必须是数字。`);
  if (turnKind === 'left') deg = Math.abs(deg);
  if (turnKind === 'right') deg = -Math.abs(deg);
  const { min: degMin, max: degMax } = SEGMENT_LIMITS.turnDeg;
  if (Math.abs(deg) < degMin || Math.abs(deg) > degMax) {
    throw new Error(
      `${label}.turn_deg=${deg} 超出范围 ±${degMin}–${degMax}°（正值=左转，负值=右转）。` +
      '要转更大角度就拆成两段（每段 ≤180°）。',
    );
  }
  const radius = Number(args.radius_m ?? args.radius ?? 0.12);
  if (!Number.isFinite(radius)) throw new Error(`${label}.radius_m 必须是数字。`);
  const { min: radMin, max: radMax } = SEGMENT_LIMITS.turnRadius;
  if (radius < radMin || radius > radMax) {
    throw new Error(
      `${label}.radius_m=${radius} 超出范围 ${radMin}–${radMax} m。` +
      `半径太小超出该机器人髋关节限位（实测可转下限约 0.10 m），建议 0.10–0.20 m。`,
    );
  }
  return {
    kind: 'turn',
    turn_deg: Math.round(deg * 10) / 10,
    radius_m: Math.round(radius * 1000) / 1000,
  };
}

/** Validate the whole composite segment list (defaults to the forward/left/right shape). */
function validateSegments(raw, warnings) {
  const list = raw === undefined || raw === null ? DEFAULT_SEGMENTS : raw;
  if (!Array.isArray(list)) {
    throw new Error('segments 必须是数组，例如 {"pattern":"composite","segments":[{"kind":"straight","length_m":0.35}]}。');
  }
  if (list.length === 0) {
    warnings.push('segments 为空，已使用默认「直行 0.35 m → 左转 90° → 右转 90°」。');
    return DEFAULT_SEGMENTS.map((entry) => ({ ...entry }));
  }
  if (list.length > SEGMENT_LIMITS.maxSegments) {
    throw new Error(`segments 最多 ${SEGMENT_LIMITS.maxSegments} 段，收到 ${list.length} 段。`);
  }
  const normalized = list.map((entry, index) => normalizeSegment(entry, index));
  for (const entry of normalized) if (entry.kind === 'sidestep') warnings.push(`没有横移步态；${entry.side === 'right' ? '右' : '左'}侧移明确替代为${entry.side === 'right' ? '右' : '左'}转 90°再直行，实际朝向会改变。`);
  const total = normalized.reduce((sum, entry) => {
    if (entry.kind === 'straight' || entry.kind === 'sidestep') return sum + entry.length_m;
    if (entry.kind === 'turn') return sum + Math.abs((entry.turn_deg * Math.PI) / 180) * entry.radius_m;
    return sum;
  }, 0);
  if (total > 1.8) {
    warnings.push(`复合轨迹总长 ${total.toFixed(2)} m 偏长，渲染时间会变长（建议 ≤1.6 m）。`);
  }
  return normalized;
}

/** Normalise one enum value through the synonym table. */
function normalizeEnum(key, value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return SYNONYMS[key].get(cleaned) ?? SYNONYMS[key].get(value.trim()) ?? value.trim();
}

/** Validate one numeric parameter against its PARAM_SPEC entry. */
function validateScalar(key, rawValue) {
  const spec = PARAM_SPEC[key];
  let value = rawValue;
  if (value === undefined || value === null || value === '') return spec.default;
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `参数 ${key} 必须是数字（${spec.zh}/${spec.en}），收到 ${JSON.stringify(rawValue)}。` +
      `允许范围：${describeRange(spec)}。`,
    );
  }
  const eps = 1e-9;
  if (value < spec.min - eps || value > spec.max + eps) {
    throw new Error(
      `参数 ${key}=${fmt(value)} 超出允许范围 ${describeRange(spec)}（${spec.zh}/${spec.en}）。` +
      `${spec.help}。请改成范围内的值，例如 ${spec.default}。`,
    );
  }
  return value;
}

/**
 * Validate and normalise a raw tool argument object.
 *
 * Missing fields fall back to their defaults so a follow-up tweak can pass only
 * the changed field. Out-of-range or unknown fields raise an Error whose message
 * is already the human-facing explanation (Chinese, with the legal range).
 *
 * @param {unknown} raw - the model-supplied arguments.
 * @returns {{params: Record<string, unknown>, warnings: string[]}}
 */
export function validateInput(raw) {
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('参数必须是一个 JSON 对象，例如 {"pattern":"line","direction":"forward"}。');
  }

  const warnings = [];
  const unknown = Object.keys(raw).filter((key) => !(key in PARAM_SPEC));
  if (unknown.length > 0) {
    throw new Error(
      `无法识别的参数：${unknown.join(', ')}。允许的参数只有 ${Object.keys(PARAM_SPEC).join(', ')}。` +
      '（其余字段保持默认或沿用上一次任务的取值。）',
    );
  }

  const params = {};
  for (const key of PARAM_ORDER) {
    const spec = PARAM_SPEC[key];
    let value = raw[key];
    if (value === undefined || value === null || value === '') {
      params[key] = spec.default;
      continue;
    }
    if (spec.type === 'enum') {
      value = normalizeEnum(key, value);
      if (!spec.values.includes(value)) {
        throw new Error(
          `参数 ${key}=${JSON.stringify(raw[key])} 不是合法取值（${spec.zh}/${spec.en}）。` +
          `允许：${describeRange(spec)}。`,
        );
      }
      params[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.trim() !== '') value = Number(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `参数 ${key} 必须是数字（${spec.zh}/${spec.en}），收到 ${JSON.stringify(raw[key])}。` +
        `允许范围：${describeRange(spec)}。`,
      );
    }
    const eps = 1e-9;
    if (value < spec.min - eps || value > spec.max + eps) {
      throw new Error(
        `参数 ${key}=${fmt(value)} 超出允许范围 ${describeRange(spec)}（${spec.zh}/${spec.en}）。` +
        `${spec.help}。请改成范围内的值，例如 ${spec.default}${
          value < spec.min ? '（你给的值偏小）' : '（你给的值偏大）'
        }。`,
      );
    }
    params[key] = value;
  }

  if (params.pattern === 'composite') {
    params.segments = validateSegments(raw.segments, warnings);
  } else if (raw.segments !== undefined && raw.segments !== null) {
    warnings.push('segments 只在 pattern="composite" 时生效，本次已忽略。');
  }
  if (params.pattern === 'hover') {
    const foot = normalizeEnum('hover_foot', raw.hover_foot ?? 'right');
    if (!PARAM_SPEC.hover_foot.values.includes(foot)) {
      throw new Error(
        `参数 hover_foot=${JSON.stringify(raw.hover_foot)} 不是合法取值（抬起的脚）。允许：left | right。`,
      );
    }
    params.hover_foot = foot;
    params.lift_height_m = validateScalar('lift_height_m', raw.lift_height_m);
    params.hold_s = validateScalar('hold_s', raw.hold_s);
    if (params.lift_height_m >= 0.05 && params.hold_s > 3) {
      warnings.push('高抬脚 + 长保持更容易触发 IK 分支极限，若几何检查失败会如实降级。');
    }
  } else if (raw.hover_foot !== undefined || raw.lift_height_m !== undefined || raw.hold_s !== undefined) {
    warnings.push('hover_foot / lift_height_m / hold_s 只在 pattern="hover" 时生效，本次已忽略。');
  }

  if (params.pattern === 'line' && raw.radius_m !== undefined && raw.radius_m !== null) {
    warnings.push('line 轨迹不使用 radius_m，已忽略该字段对形状的影响。');
  }
  if (params.pattern === 'figure8' && params.radius_m < 0.07) {
    warnings.push('figure8 在半径偏小时更容易触发几何检查降级，建议 radius_m ≥ 0.07。');
  }
  if (params.pattern !== 'line' && params.laps > 1.5) {
    warnings.push('圈数较多时渲染时间会明显变长。');
  }
  return { params, warnings };
}

/**
 * Merge a partial call with the previous task's params.
 *
 * The tuning closed loop ("圈再大一点") only changes one field; without this
 * merge an omitted `pattern` would fall back to `line` and silently discard the
 * arc the user just watched. Explicit values always win; unknown keys are left
 * for `validateInput` to reject.
 *
 * @param {unknown} raw - model-supplied arguments.
 * @param {Record<string, unknown> | null | undefined} lastParams - previous task params.
 * @returns {{merged: Record<string, unknown>, inherited: string[]}}
 */
export function inheritParams(raw, lastParams) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!lastParams || typeof lastParams !== 'object') return { merged: input, inherited: [] };
  const merged = { ...input };
  const inherited = [];
  const nextPattern = normalizeEnum('pattern', merged.pattern ?? lastParams.pattern ?? 'line');
  const fields = fieldsForPattern(typeof nextPattern === 'string' ? nextPattern : 'line');
  for (const key of fields) {
    if (merged[key] !== undefined && merged[key] !== null && merged[key] !== '') continue;
    if (lastParams[key] === undefined || lastParams[key] === null) continue;
    merged[key] = lastParams[key];
    inherited.push(key);
  }
  return { merged, inherited };
}

/** One-line Chinese description of a parameter set, used in tool results. */
/** One-line Chinese description of one composite segment. */
function segmentLabel(entry) {
  if (entry.kind === 'straight') return `直行 ${fmt(entry.length_m)} m`;
  if (entry.kind === 'sidestep') return `${entry.side === 'right' ? '右侧移' : '左侧移'} ${fmt(entry.length_m)} m`;
  if (entry.kind === 'hover') {
    const foot = entry.hover_foot === 'left' ? '左脚' : '右脚';
    return `悬停抬${foot} ${fmt(entry.hold_s)} s`;
  }
  if (entry.kind === 'stand') return `站立 ${fmt(entry.hold_s)} s`;
  const side = entry.turn_deg >= 0 ? '左转' : '右转';
  return `${side} ${Math.abs(entry.turn_deg).toFixed(0)}° (R${fmt(entry.radius_m)})`;
}

/** One-line Chinese summary of a segment list. */
export function summarizeSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments.map(segmentLabel).join(' → ');
}

export function summarizeParams(params) {
  const directionZh = params.direction === 'backward' ? '倒退' : '前进';
  const speedZh = { slow: '慢速', normal: '常速', fast: '快速' }[params.speed] ?? params.speed;
  if (params.pattern === 'composite') {
    return [`${directionZh}复合轨迹`, summarizeSegments(params.segments), `步长 ${fmt(params.step_length_m)} m`, speedZh]
      .filter(Boolean).join(' · ');
  }
  if (params.pattern === 'hover') {
    const foot = params.hover_foot === 'left' ? '左脚' : '右脚';
    return [`单脚悬停：${foot}抬起 ${(Number(params.lift_height_m) * 100).toFixed(1)} cm`,
      `保持 ${fmt(params.hold_s)} s`].join(' · ');
  }
  const patternZh = { line: '直线', arc: '弧线', figure8: '8 字' }[params.pattern] ?? params.pattern;
  const parts = [`${directionZh}走${patternZh}`];
  parts.push(`步长 ${fmt(params.step_length_m)} m`);
  if (params.pattern !== 'line') parts.push(`半径 ${fmt(params.radius_m)} m`);
  parts.push(`圈数 ${fmt(params.laps)}`, speedZh);
  return parts.join(' · ');
}

/**
 * The `duck_templates` payload: template catalogue, exact parameter schema,
 * Chinese synonym hints, and the recent tasks used for parameter tuning.
 *
 * @param {{recentTasks?: Array<Record<string, unknown>>}} options
 * @returns {Record<string, unknown>}
 */
export function buildTemplates(options = {}) {
  const templates = [
    {
      name: 'line',
      label_en: 'Straight line walk',
      label_zh: '直线行走',
      description: 'Walks forward or backward in a straight line. laps = number of traversals (1 ≈ 0.6 m).',
      description_zh: '沿直线前进或倒退；laps 表示直线的趟数（1 趟约 0.6 m）。',
      uses: ['direction', 'step_length_m', 'laps', 'speed'],
      not_used: ['radius_m'],
      examples_zh: ['往前直走两步', '倒退走直线，步子小一点'],
    },
    {
      name: 'arc',
      label_en: 'Arc / circle walk',
      label_zh: '弧线 / 绕圈',
      description: 'Walks along an arc of the given radius; laps >= 1 closes a circle.',
      description_zh: '沿给定半径的弧线行走；laps 达到 1 即绕一圈。',
      uses: ['direction', 'step_length_m', 'radius_m', 'laps', 'speed'],
      not_used: [],
      examples_zh: ['绕一个半径 10 厘米的圈', '倒着绕圈走，圈再大一点'],
    },
    {
      name: 'figure8',
      label_en: 'Figure-8 walk',
      label_zh: '8 字行走',
      description: 'Walks a figure-8; may degrade to an arc pair when this robot cannot cross the two feet.',
      description_zh: '走 8 字轨迹；若该机器人无法完成双脚交叉，会降级为两段弧线并在结果里如实说明。',
      uses: ['direction', 'step_length_m', 'radius_m', 'laps', 'speed'],
      not_used: [],
      examples_zh: ['倒退走8字，步子小一点', '走一个8字'],
    },
    {
      name: 'composite',
      label_en: 'Segmented walk (forward / left / right …)',
      label_zh: '分段组合轨迹',
      description:
        'Walks a timeline of locomotion and pose segments in one clip: straight, turn, sidestep (degrades to turn+straight), hover, stand.',
      description_zh:
        '在一个 clip 里按时间轴执行多段：直行、转弯、侧移（无横移时降级为转弯再直行）、单脚悬停、站立保持。',
      uses: ['direction', 'step_length_m', 'segments', 'speed'],
      not_used: ['radius_m', 'laps'],
      examples_zh: [
        '鸭子往前走，然后向左转弯，再向右转',
        '向左走，然后再单脚站立',
        '先直走半米，再左转 120 度',
      ],
    },
    {
      name: 'hover',
      label_en: 'Single-foot hover (stand on one leg)',
      label_zh: '单脚悬停',
      description:
        'Stands on one sole and lifts the other, holds it, then sets it back down. No travel: this is a pose gesture.',
      description_zh: '一只脚支撑、另一只脚抬起并保持（可指定左右脚、抬多高、保持多久），然后放下；原地姿态类动作。',
      uses: ['hover_foot', 'lift_height_m', 'hold_s', 'speed'],
      not_used: ['direction', 'step_length_m', 'radius_m', 'laps', 'segments'],
      examples_zh: ['单脚悬停', '抬一只脚站着别动', '右脚抬起来保持 3 秒', '左脚悬停，抬低一点'],
    },
  ];

  const parameter_schema = {};
  for (const key of PARAM_ORDER) {
    const spec = PARAM_SPEC[key];
    parameter_schema[key] = {
      type: spec.type,
      required: false,
      default: spec.default,
      ...(spec.type === 'number' ? { minimum: spec.min, maximum: spec.max, unit: spec.unit ?? null } : {}),
      ...(spec.type === 'enum' ? { values: spec.values } : {}),
      description_zh: spec.zh,
      description_en: spec.en,
      hint_zh: spec.help,
    };
  }
  parameter_schema.segments = {
    type: 'array',
    required: false,
    only_for_pattern: 'composite',
    default_segments: DEFAULT_SEGMENTS,
    description_zh: PARAM_SPEC.segments.zh,
    description_en: PARAM_SPEC.segments.en,
    hint_zh: PARAM_SPEC.segments.help,
    item_schema: {
      kind: 'straight | turn | left | right | sidestep | hover | stand',
      'straight.length_m': `${SEGMENT_LIMITS.straight.min}–${SEGMENT_LIMITS.straight.max} m`,
      'turn.turn_deg': `±${SEGMENT_LIMITS.turnDeg.min}–${SEGMENT_LIMITS.turnDeg.max}°（正=左转，负=右转）`,
      'turn.radius_m': `${SEGMENT_LIMITS.turnRadius.min}–${SEGMENT_LIMITS.turnRadius.max} m`,
      'sidestep.side': 'left | right（无横移步态时降级为转弯 90° 再直行）',
      'hover.hover_foot': 'left | right',
      'stand.hold_s': `${SEGMENT_LIMITS.hold.min}–${SEGMENT_LIMITS.hold.max} s`,
      max_segments: SEGMENT_LIMITS.maxSegments,
    },
  };
  for (const key of ['hover_foot', 'lift_height_m', 'hold_s']) {
    const spec = PARAM_SPEC[key];
    parameter_schema[key] = {
      type: spec.type,
      required: false,
      default: spec.default,
      only_for_pattern: 'hover',
      description_zh: spec.zh,
      description_en: spec.en,
      hint_zh: spec.help,
      ...(spec.type === 'number' ? { minimum: spec.min, maximum: spec.max, unit: spec.unit ?? null } : { values: spec.values }),
    };
  }

  const synonyms = {};
  for (const [key, table] of Object.entries(SYNONYMS)) {
    const byCanonical = {};
    for (const [word, canonical] of table) {
      if (!byCanonical[canonical]) byCanonical[canonical] = [];
      if (word !== canonical && !byCanonical[canonical].includes(word)) byCanonical[canonical].push(word);
    }
    synonyms[key] = byCanonical;
  }

  return {
    templates,
    parameter_schema,
    synonyms_zh: synonyms,
    defaults: Object.fromEntries(PARAM_ORDER.map((key) => [key, PARAM_SPEC[key].default])),
    tuning_rule:
      '参数微调：只传要改的字段重新调用 duck_preview —— 未传的字段会自动沿用 recent_tasks[0]（上一次任务）的取值，' +
      '所以「圈再大一点」只传 radius_m 即可；也可以直接以 recent_tasks[0].params 为基准显式传全套。',
    output_contract: {
      status_values: ['queued', 'running', 'done', 'error'],
      on_done: 'duck_preview 返回 video_path（本机 mp4 绝对路径）、video_url（Web 面板/浏览器可播放）与 metrics 摘要；Web 的 Microduck Preview 面板会自动出现视频。',
      on_running: '如果 status=running，用 duck_status(task_id) 轮询，不要重复提交新任务。',
      on_error: 'status=error 时按 error 字段向用户如实说明原因（含几何检查失败/降级）。',
    },
    recent_tasks: options.recentTasks ?? [],
    last_params: options.recentTasks?.[0]?.params ?? null,
    tips_zh: [
      '用户用中文描述动作（如“倒退走8字，步子小一点”），据此填 pattern/direction/step_length_m 等字段。',
      '“步子小一点” → step_length_m 取 0.02–0.03；“圈再大一点” → radius_m 加 0.01–0.02（不超过 0.15）。',
      '只做 Microduck 本体步态/轨迹预览；球类交互与训练不在范围内。',
    ],
  };
}
