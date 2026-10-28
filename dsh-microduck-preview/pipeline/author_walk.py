#!/usr/bin/env python3
"""Author parameterised Microduck locomotion references + geometric inspection.

WHY THIS EXISTS
---------------
The DSH plugin `dsh-microduck-preview` lets a user ask for a Microduck motion in
plain Chinese ("倒退走8字，步子小一点").  That request becomes the parameter
set below; this module turns it into joint/root arrays that can be rendered,
*without* training and *without* any video input:

    params -> root/feet world-target clip -> constrained IK -> motion.json
           -> geometric inspection (joint limits / ground / self-collision)

The authoring patterns (Clip / smooth swing / constrained least-squares IK
against the real foot sites) are adapted from
``microduck-marseille/scripts/author_marseille_motion.py``, which is the same
project's verified authoring approach.  The robot model, HOME pose and joint
ranges come from the external asset repo (read-only):

    <asset_root>/src/mjlab_microduck/robot/microduck/robot_groundcontact.xml

The geometric inspection follows ``mvi.robot.geometry`` (the same check the
video pipeline uses) but is re-implemented on the raw MuJoCo model so that it
takes well under a second, stays dependency-light (mujoco/numpy only), and does
not need a review-bundle layout.

HONESTY RULE
------------
Joint-limit / penetration / self-collision results are reported, never hidden.
If the requested pattern fails the inspection, this module retries with the
closest arc-based fallback and reports ``degraded`` + ``degrade_reason`` so the
plugin can tell the user the truth instead of showing a wrong motion.

PUBLIC API
----------
    author_motion(params_dict) -> AuthorResult
        .motion   motion.json-compatible dict (50 Hz)
        .geometry inspection dict
        .params   normalised params
        .effective_pattern / degraded / degrade_reason / warnings
    validate_params(params_dict) -> normalised params (raises AuthorError)

CLI (debug / standalone authoring):
    python author_walk.py --params-json params.json --out-dir /tmp/author
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------- #
# constants
# --------------------------------------------------------------------------- #
HZ = 50                       # authoring / motion.json rate
DT = 1.0 / HZ

DEFAULT_ASSET_ROOT = Path("/Users/founderlin/Desktop/RL研发/microduck-marseille")
ROBOT_XML_REL = Path("src/mjlab_microduck/robot/microduck/robot_groundcontact.xml")

# HOME_FRAME.joint_pos (STAND2 pose) copied from
# microduck_constants.HOME_FRAME so this module does not need to import mjlab.
HOME_JOINT_POS = {
    r".*hip_yaw.*": 0.0,
    r".*left_hip_roll.*": -0.0873,
    r".*right_hip_roll.*": 0.0873,
    r".*left_hip_pitch.*": -0.4579,
    r".*right_hip_pitch.*": 0.4579,
    r".*left_knee.*": -0.0049,
    r".*right_knee.*": 0.0049,
    r".*left_ankle.*": 0.4530,
    r".*right_ankle.*": -0.4530,
    r".*neck_pitch.*": 0.3491,
    r".*head_pitch.*": 0.3491,
    r".*head_yaw.*": 0.0,
    r".*head_roll.*": 0.0,
}

# retarget settings copied from experiments/project-config.json (the verified
# authoring settings used by author_marseille_motion.py).
RETARGET = {
    "joint_margin_deg": 2.0,
    "ik_position_scale_m": 0.015,
    "ik_sole_orientation_weight": 0.5,
    "ik_smoothness_weight": 0.06,
    "ik_posture_weight": 0.05,
    "ik_sole_yaw_weight": 0.25,
    "ik_max_frame_delta_rad": 0.22,
    "ik_max_evaluations": 260,
}
CHECKS = {
    "penetration_tolerance_m": 0.001,
    "maximum_joint_speed_rad_s": 12.0,
    "maximum_ik_foot_error_mm": 5.0,
}

FOOT_SITE_NAMES = ("left_foot", "right_foot")
SOLE_GEOM_NAMES = ("left_foot_collision", "right_foot_collision")

# gait / clip tuning
INTRO_S = 0.40                 # stand-and-settle prefix (both feet planted)
OUTRO_S = 0.45                 # settle suffix
SWING_START = 0.15             # swing window inside a step (fraction)
SWING_END = 0.85
SWING_HEIGHT_MIN = 0.014
SWING_HEIGHT_MAX = 0.026
BOB_AMP_M = 0.0015             # vertical root bob, peak mid single-support
SWAY_AMP_M = 0.0025            # lateral root shift toward the support foot
STANCE_TARGET_LIFT_M = 0.0008  # keep planted soles ~0.8 mm above z=0 (IK tilt tolerance)
ROOT_CROUCH_M = 0.005          # walk with a slightly bent-knee stance (more reach)
HOME_STANCE_HALF_WIDTH_M = 0.0418  # HOME sole lateral offset (model-checked in build_model)

# Single-foot hover ("单脚悬停"): one sole stays planted, the other lifts and holds.
HOVER_LIFT_RANGE_M = (0.02, 0.08)   # sole clearance above its planted height
HOVER_HOLD_RANGE_S = (0.5, 5.0)     # hold duration
HOVER_LIFT_S = 0.7                  # lift ramp duration
HOVER_LOWER_S = 0.7                 # lower ramp duration
HOVER_SWAY_M = 0.012                # root shift toward the support foot (visual balance)
HOVER_TUCK_X_M = 0.006              # lifted sole tucks slightly forward …
HOVER_TUCK_Y_M = 0.004              # … and inward (also keeps IK on one branch)

LAP_LINE_M = 0.55              # one "lap" of the straight-line pattern
FIG8_LOBE_FACTOR = 1.5         # Gerono semi-axis a = FIG8_LOBE_FACTOR * radius_m

BASE_STEP_TIME = {"slow": 0.44, "normal": 0.34, "fast": 0.27}
STEP_TIME_REF_M = 0.035        # base step time is quoted at this step length
STEP_TIME_MIN_S = 0.16
STEP_TIME_MAX_S = 0.80
MIN_MOTION_S = 6.0             # stretch the cadence up to this if a clip is tiny
MAX_TOTAL_FRAMES = 840         # 16.8 s at 50 Hz => 420 rendered frames at 25 fps
# Composite trajectories are never trimmed per-segment (that would silently drop
# a turn); a longer allowance is used and only the CADENCE is compressed if the
# requested path would exceed ~20 s of footage.
COMPOSITE_MAX_TOTAL_FRAMES = 1000   # 20.0 s at 50 Hz => 500 rendered frames at 25 fps
MAX_RENDER_FPS = 25

PARAM_ORDER = ("pattern", "direction", "step_length_m", "radius_m", "laps", "speed",
               "segments", "hover_foot", "lift_height_m", "hold_s")
PATTERNS = ("line", "arc", "figure8", "composite", "hover")
DIRECTIONS = ("forward", "backward")
SPEEDS = ("slow", "normal", "fast")

# Composite (segmented) trajectories: a straight run is `length_m`; a turn is a
# circular arc of `radius_m` sweeping `turn_deg` (positive = left / CCW). This
# robot turns reliably at R >= 0.10 m, so smaller requests are raised with a
# warning instead of failing the whole clip.
SEGMENT_MAX_COUNT = 6
SEGMENT_STRAIGHT_RANGE = (0.05, 1.5)
SEGMENT_TURN_DEG_RANGE = (0.1, 180.0)
SEGMENT_TURN_RADIUS_RANGE = (0.06, 0.30)
SEGMENT_MIN_TURN_RADIUS_M = 0.10
_SEGMENT_WARNINGS: list[str] = []

# hard-error reason strings (kept identical to the video pipeline's wording)
REASON_JOINT_LIMIT = "joint limit"
REASON_GROUND = "ground penetration"
REASON_SELF = "self collision"
REASON_SPEED = "joint speed limit"


class AuthorError(RuntimeError):
    """Raised when a motion cannot be authored even after degradation."""


# --------------------------------------------------------------------------- #
# parameter validation
# --------------------------------------------------------------------------- #
def _number(params: dict, key: str, lo: float, hi: float) -> float:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AuthorError(f"参数 {key} 必须是数字 (got {value!r})")
    value = float(value)
    if not math.isfinite(value):
        raise AuthorError(f"参数 {key} 必须是有限数字")
    if value < lo - 1e-9 or value > hi + 1e-9:
        raise AuthorError(f"参数 {key}={value:g} 超出范围 [{lo:g}, {hi:g}]")
    return value


def normalize_segments(segments) -> list[dict]:
    """Validate/normalise a composite segment list (left/right shorthands allowed)."""
    if not isinstance(segments, list) or not segments:
        raise AuthorError(
            "composite 需要非空的 segments 数组，例如 "
            '[{"kind":"straight","length_m":0.35},{"kind":"turn","turn_deg":90,"radius_m":0.12}]'
        )
    if len(segments) > SEGMENT_MAX_COUNT:
        raise AuthorError(f"segments 最多 {SEGMENT_MAX_COUNT} 段 (got {len(segments)})")
    out: list[dict] = []
    for index, entry in enumerate(segments):
        label = f"segments[{index}]"
        if not isinstance(entry, dict):
            raise AuthorError(f"{label} 必须是对象")
        kind = str(entry.get("kind", "")).strip().lower()
        if kind in ("straight", "line", "直行", "前进"):
            raw = entry.get("length_m", entry.get("distance_m"))
            try:
                length = float(raw)
            except (TypeError, ValueError):
                raise AuthorError(f"{label}.length_m 必须是数字 (got {raw!r})")
            lo, hi = SEGMENT_STRAIGHT_RANGE
            if length < lo - 1e-9 or length > hi + 1e-9:
                raise AuthorError(f"{label}.length_m={length:g} 超出范围 [{lo:g}, {hi:g}]")
            out.append({"kind": "straight", "length_m": round(length, 4)})
            continue
        if kind in ("turn", "left", "right", "转弯", "转向", "左转", "右转"):
            raw_deg = entry.get("turn_deg", entry.get("deg", entry.get("angle_deg", 90)))
            try:
                deg = float(raw_deg)
            except (TypeError, ValueError):
                raise AuthorError(f"{label}.turn_deg 必须是数字 (got {raw_deg!r})")
            if kind in ("left", "左转"):
                deg = abs(deg)
            elif kind in ("right", "右转"):
                deg = -abs(deg)
            lo, hi = SEGMENT_TURN_DEG_RANGE
            if abs(deg) < lo - 1e-9 or abs(deg) > hi + 1e-9:
                raise AuthorError(f"{label}.turn_deg={deg:g} 超出范围 ±[{lo:g}, {hi:g}]")
            raw_radius = entry.get("radius_m", entry.get("radius", 0.12))
            try:
                radius = float(raw_radius)
            except (TypeError, ValueError):
                raise AuthorError(f"{label}.radius_m 必须是数字 (got {raw_radius!r})")
            lo_r, hi_r = SEGMENT_TURN_RADIUS_RANGE
            if radius < lo_r - 1e-9 or radius > hi_r + 1e-9:
                raise AuthorError(f"{label}.radius_m={radius:g} 超出范围 [{lo_r:g}, {hi_r:g}]")
            if radius < SEGMENT_MIN_TURN_RADIUS_M - 1e-9:
                _SEGMENT_WARNINGS.append(
                    f"第 {index + 1} 段转弯半径 {radius:.2f} m 小于该机器人可行下限 "
                    f"{SEGMENT_MIN_TURN_RADIUS_M:.2f} m，已上调到 {SEGMENT_MIN_TURN_RADIUS_M:.2f} m"
                )
                radius = SEGMENT_MIN_TURN_RADIUS_M
            out.append({"kind": "turn", "turn_deg": round(deg, 2), "radius_m": round(radius, 4)})
            continue
        raise AuthorError(
            f"{label}.kind={entry.get('kind')!r} 无法识别；允许 straight / turn / left / right"
        )
    return out


def validate_params(params: dict) -> dict:
    """Defensive validation of the duck_preview params (host validates too)."""
    if not isinstance(params, dict):
        raise AuthorError("params 必须是 JSON object")
    unknown = set(params) - set(PARAM_ORDER)
    if unknown:
        raise AuthorError(f"未知参数: {', '.join(sorted(unknown))}")
    pattern = params.get("pattern", "line")
    if pattern not in PATTERNS:
        raise AuthorError(f"pattern 必须是 {list(PATTERNS)} 之一 (got {pattern!r})")
    direction = params.get("direction", "forward")
    if direction not in DIRECTIONS:
        raise AuthorError(f"direction 必须是 {list(DIRECTIONS)} 之一 (got {direction!r})")
    speed = params.get("speed", "normal")
    if speed not in SPEEDS:
        raise AuthorError(f"speed 必须是 {list(SPEEDS)} 之一 (got {speed!r})")
    _SEGMENT_WARNINGS.clear()
    step_length = _number(params, "step_length_m", 0.02, 0.06)
    if pattern == "hover":
        hover_foot = str(params.get("hover_foot", "right")).strip().lower()
        if hover_foot in ("左脚", "l", "leftfoot"):
            hover_foot = "left"
        if hover_foot in ("右脚", "r", "rightfoot"):
            hover_foot = "right"
        if hover_foot not in ("left", "right"):
            raise AuthorError(f"hover_foot 必须是 'left' 或 'right' (got {params.get('hover_foot')!r})")
        lo, hi = HOVER_LIFT_RANGE_M
        lift = params.get("lift_height_m", 0.05)
        if isinstance(lift, bool) or not isinstance(lift, (int, float)):
            raise AuthorError(f"lift_height_m 必须是数字 (got {lift!r})")
        lift = float(lift)
        if lift < lo - 1e-9 or lift > hi + 1e-9:
            raise AuthorError(f"lift_height_m={lift:g} 超出范围 [{lo:g}, {hi:g}]")
        lo_h, hi_h = HOVER_HOLD_RANGE_S
        hold = params.get("hold_s", 2.5)
        if isinstance(hold, bool) or not isinstance(hold, (int, float)):
            raise AuthorError(f"hold_s 必须是数字 (got {hold!r})")
        hold = float(hold)
        if hold < lo_h - 1e-9 or hold > hi_h + 1e-9:
            raise AuthorError(f"hold_s={hold:g} 超出范围 [{lo_h:g}, {hi_h:g}]")
        return {
            "pattern": "hover",
            "direction": direction,
            "step_length_m": step_length,
            "speed": speed,
            "hover_foot": hover_foot,
            "lift_height_m": round(lift, 4),
            "hold_s": round(hold, 2),
        }
    if pattern == "composite":
        # top-level radius_m / laps are ignored for composite on purpose
        return {
            "pattern": "composite",
            "direction": direction,
            "step_length_m": step_length,
            "speed": speed,
            "segments": normalize_segments(params.get("segments")),
        }
    return {
        "pattern": pattern,
        "direction": direction,
        "step_length_m": step_length,
        "radius_m": _number(params, "radius_m", 0.05, 0.15),
        "laps": _number(params, "laps", 0.5, 3.0),
        "speed": speed,
    }


# --------------------------------------------------------------------------- #
# robot model / geometry helpers
# --------------------------------------------------------------------------- #
@dataclass
class ModelBundle:
    m: object
    d: object
    ids: list
    names: list
    qa: np.ndarray
    home: np.ndarray
    homefeet: np.ndarray
    homez: float
    feet_ids: list
    homerots: np.ndarray
    soles: list
    colliding: list
    xml_path: Path


def resolve_asset_root() -> Path:
    root = Path(os.environ.get("MICRODUCK_ASSET_ROOT") or DEFAULT_ASSET_ROOT)
    xml = root / ROBOT_XML_REL
    if not xml.is_file():
        raise AuthorError(
            f"找不到 Microduck 机器人模型: {xml} (设置 MICRODUCK_ASSET_ROOT 指向 microduck-marseille 仓库根目录)"
        )
    return root


def build_model() -> ModelBundle:
    """Compile the robot model and resolve HOME stance / foot sites."""
    import mujoco

    xml_path = resolve_asset_root() / ROBOT_XML_REL
    spec = mujoco.MjSpec.from_file(str(xml_path))
    m = spec.compile()
    d = mujoco.MjData(m)

    ids = [
        j
        for j in range(m.njnt)
        if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE
        and not m.joint(j).name.startswith("passive_")
    ]
    names = [m.joint(j).name for j in ids]
    qa = m.jnt_qposadr[ids]
    try:
        home = np.array(
            [next(v for p, v in HOME_JOINT_POS.items() if re.fullmatch(p, n)) for n in names]
        )
    except StopIteration as exc:  # pragma: no cover - only if the robot changes
        raise AuthorError(f"机器人关节与 HOME 姿态不匹配: {exc.args[0]}") from None

    d.qpos[qa] = home
    d.qpos[:3] = [0.0, 0.0, 0.15]
    d.qpos[3:7] = [1.0, 0.0, 0.0, 0.0]
    mujoco.mj_forward(m, d)

    soles = [m.geom(n).id for n in SOLE_GEOM_NAMES]
    feet_ids = [m.site(n).id for n in FOOT_SITE_NAMES]
    lowest = min(geom_min_z(m, d, g) for g in soles)
    d.qpos[2] = 0.15 - lowest
    mujoco.mj_forward(m, d)
    homefeet = d.site_xpos[feet_ids].copy()
    homez = float(d.qpos[2])
    homerots = d.site_xmat[feet_ids].reshape(2, 3, 3).copy()

    colliding = [
        g
        for g in range(m.ngeom)
        if m.geom_type[g] != mujoco.mjtGeom.mjGEOM_PLANE
        and (m.geom_contype[g] or m.geom_conaffinity[g])
    ]
    return ModelBundle(
        m=m, d=d, ids=ids, names=names, qa=qa, home=home, homefeet=homefeet,
        homez=homez, feet_ids=feet_ids, homerots=homerots, soles=soles,
        colliding=colliding, xml_path=xml_path,
    )


def geom_min_z(m, d, g) -> float:
    """Lowest world z of a geom (mirrors mvi.robot.geom_min_z)."""
    import mujoco

    kind = m.geom_type[g]
    rot = d.geom_xmat[g].reshape(3, 3)
    size = m.geom_size[g]
    z = float(d.geom_xpos[g, 2])
    if kind == mujoco.mjtGeom.mjGEOM_PLANE:
        return float("inf")
    if kind == mujoco.mjtGeom.mjGEOM_MESH:
        mid = m.geom_dataid[g]
        verts = m.mesh_vert[m.mesh_vertadr[mid]: m.mesh_vertadr[mid] + m.mesh_vertnum[mid]]
        return float((verts @ rot.T + d.geom_xpos[g])[:, 2].min())
    if kind == mujoco.mjtGeom.mjGEOM_SPHERE:
        return z - float(size[0])
    if kind == mujoco.mjtGeom.mjGEOM_CAPSULE:
        return z - abs(rot[2, 2]) * float(size[1]) - float(size[0])
    if kind == mujoco.mjtGeom.mjGEOM_CYLINDER:
        return z - abs(rot[2, 2]) * float(size[1]) - float(np.linalg.norm(rot[2, :2])) * float(size[0])
    return z - float(np.abs(rot[2]) @ size)


def smooth(x: float) -> float:
    x = float(np.clip(x, 0.0, 1.0))
    return x * x * (3.0 - 2.0 * x)


# --------------------------------------------------------------------------- #
# path descriptions (root trajectory in the world)
# --------------------------------------------------------------------------- #
PATH_PAD_M = 0.12  # arclength margin sampled either side of the requested path


class TrajectoryPath:
    """Root trajectory in the world, arclength-parameterised (+ heading).

    The sampled arclength grid extends PATH_PAD_M before/after the requested
    path so the steady-state foot plants (which sit up to ~0.65 step behind or
    in front of the root) can be evaluated without clipping.
    """

    def __init__(self, kind: str, s_grid: np.ndarray, xy: np.ndarray,
                 heading: np.ndarray, lap_length: float, start_s: float,
                 total_length: float):
        if len(s_grid) < 2 or s_grid[-1] - s_grid[0] <= 1e-9:
            raise AuthorError("内部错误：路径长度为 0")
        self.kind = kind
        self._s = np.asarray(s_grid, float)
        self._xy = np.asarray(xy, float)
        self._h = np.unwrap(np.asarray(heading, float))
        self.lap_length = float(lap_length)
        self.start_s = float(start_s)
        self.total_length = float(total_length)

    def xy(self, s: float) -> np.ndarray:
        u = float(np.clip(self.start_s + s, self._s[0], self._s[-1]))
        return np.array([np.interp(u, self._s, self._xy[:, 0]),
                         np.interp(u, self._s, self._xy[:, 1])])

    def heading(self, s: float) -> float:
        u = float(np.clip(self.start_s + s, self._s[0], self._s[-1]))
        return float(np.interp(u, self._s, self._h))

    def left_normal(self, s: float) -> np.ndarray:
        h = self.heading(s)
        return np.array([-math.sin(h), math.cos(h)])

    def sample_points(self, n: int = 400) -> np.ndarray:
        s = np.linspace(0.0, self.total_length, n)
        return np.stack([np.interp(self.start_s + s, self._s, self._xy[:, 0]),
                         np.interp(self.start_s + s, self._s, self._xy[:, 1])], axis=1)


def _resample_path(kind: str, dense_xy: np.ndarray, dense_heading: np.ndarray,
                   start_u: float, end_u: float, lap_u: float) -> TrajectoryPath:
    """Resample a densely-sampled curve into uniform arclength coordinates."""
    seg = np.linalg.norm(np.diff(dense_xy, axis=0), axis=1)
    u = np.r_[0.0, np.cumsum(seg)]
    total = float(u[-1])
    n = max(400, int(total / 0.0002) + 2)
    uq = np.linspace(0.0, total, n)
    xyq = np.stack([np.interp(uq, u, dense_xy[:, 0]),
                    np.interp(uq, u, dense_xy[:, 1])], axis=1)
    hq = np.interp(uq, u, np.unwrap(dense_heading))
    return TrajectoryPath(kind, uq, xyq, hq, lap_u, start_u, end_u - start_u)


def make_composite_path(segments: list[dict]) -> TrajectoryPath:
    """Root path for a segmented (straight / left / right) trajectory.

    Integrates the signed curvature along the requested segments: straight runs
    have k = 0, turns have k = sign(turn_deg) / radius_m. Heading is therefore
    continuous by construction (C1 at every junction), which is what keeps the
    per-step body yaw change at the same magnitude as the verified arc case.
    """
    if not segments:
        raise AuthorError("composite 需要 segments")
    ds = 0.001
    points: list[np.ndarray] = [np.zeros(2)]
    headings: list[float] = [0.0]
    current = np.zeros(2)
    heading = 0.0
    total = 0.0
    for segment in segments:
        if segment["kind"] == "straight":
            length = float(segment["length_m"])
            steps = max(2, int(round(length / ds)))
            step = length / steps
            for _ in range(steps):
                current = current + step * np.array([math.cos(heading), math.sin(heading)])
                points.append(current.copy())
                headings.append(heading)
            total += length
        else:
            radius = float(segment["radius_m"])
            sweep = math.radians(float(segment["turn_deg"]))
            arc = abs(sweep) * radius
            steps = max(8, int(round(arc / ds)))
            step = arc / steps
            d_heading = sweep / steps
            for _ in range(steps):
                mid = heading + 0.5 * d_heading
                current = current + step * np.array([math.cos(mid), math.sin(mid)])
                heading += d_heading
                points.append(current.copy())
                headings.append(heading)
            total += arc
    if total <= 1e-6:
        raise AuthorError("复合轨迹总长度为 0，请检查 segments")
    # Arclength padding before/after the requested path, along the end headings.
    start_xy = points[0] - PATH_PAD_M * np.array([math.cos(headings[0]), math.sin(headings[0])])
    end_xy = points[-1] + PATH_PAD_M * np.array([math.cos(headings[-1]), math.sin(headings[-1])])
    dense_xy = np.vstack([start_xy[None, :], np.asarray(points), end_xy[None, :]])
    dense_heading = np.r_[headings[0], np.asarray(headings), headings[-1]]
    return _resample_path("composite", dense_xy, dense_heading,
                          PATH_PAD_M, PATH_PAD_M + total, total)


def make_path(pattern: str, radius_m: float, laps: float,
              segments: list[dict] | None = None) -> TrajectoryPath:
    """Build the requested pattern's root path.

    * line    : straight traversal along world +x; one lap = LAP_LINE_M.
    * arc     : circular arc, radius_m, starting at the origin heading +x and
                curving to the left; one lap = circumference.
    * figure8 : Gerono lemniscate (smooth figure-eight) whose lobe semi-axis is
                1.5 * radius_m; one lap = one full figure-eight.
    """
    if pattern == "line":
        lap = LAP_LINE_M
        total = max(lap * laps, 0.12)
        n = max(400, int((total + 2 * PATH_PAD_M) * 5000))
        s = np.linspace(-PATH_PAD_M, total + PATH_PAD_M, n)
        xy = np.stack([s, np.zeros_like(s)], axis=1)
        return TrajectoryPath("line", s, xy, np.zeros_like(s), lap, 0.0, total)

    if pattern == "arc":
        R = float(radius_m)
        lap = 2.0 * math.pi * R
        total = lap * laps
        n = max(400, int((total + 2 * PATH_PAD_M) * 5000))
        s = np.linspace(-PATH_PAD_M, total + PATH_PAD_M, n)
        phi = s / R
        center = np.array([0.0, R])
        xy = center + R * np.stack([np.sin(phi), -np.cos(phi)], axis=1)
        return TrajectoryPath("arc", s, xy, phi, lap, 0.0, total)

    if pattern == "figure8":
        # Two externally tangent circles traced as an infinity (8) curve: a
        # left-hand lobe above the tangent point followed by a right-hand lobe
        # below it. Heading is continuous through the tangent point; only the
        # curvature flips sign there, so the per-step body yaw change stays the
        # same magnitude as the verified arc case (|d yaw| = step / R) instead
        # of the much sharper waist turn of a lemniscate.  One lap = one full 8.
        R = float(radius_m)
        lap = 4.0 * math.pi * R
        total = lap * laps
        period = lap
        n = max(1600, int((total + 2 * PATH_PAD_M) * 4000))
        s = np.linspace(-PATH_PAD_M, total + PATH_PAD_M, n)
        m = np.mod(s, period)
        phi = np.mod(m, 2.0 * math.pi * R) / R
        upper = m <= 2.0 * math.pi * R
        xy = np.empty((n, 2))
        xy[upper, 0] = R * np.sin(phi[upper])
        xy[upper, 1] = R - R * np.cos(phi[upper])
        xy[~upper, 0] = R * np.sin(phi[~upper])
        xy[~upper, 1] = -R + R * np.cos(phi[~upper])
        heading = np.where(upper, phi, 2.0 * math.pi - phi)
        # rotate -90 deg: the two tangent circles become left/right lobes
        xy = np.stack([xy[:, 1], -xy[:, 0]], axis=1)
        heading = heading - 0.5 * math.pi
        return TrajectoryPath("figure8", s, xy, heading, lap, 0.0, total)

    if pattern == "composite":
        return make_composite_path(segments or [])

    raise AuthorError(f"未实现的 pattern: {pattern}")


# --------------------------------------------------------------------------- #
# gait plan
# --------------------------------------------------------------------------- #
@dataclass
class GaitPlan:
    n_steps: int
    step_m: float
    step_frames: int
    intro_frames: int
    outro_frames: int
    swing_h: float
    duration_s: float
    total_frames: int
    trimmed: bool
    trimmed_from_laps: float
    path: TrajectoryPath
    cadence_compressed: bool = False

    @property
    def step_s(self) -> float:
        return self.step_frames * DT

    @property
    def laps_effective(self) -> float:
        return self.travel_m / self.path.lap_length

    @property
    def travel_m(self) -> float:
        return self.n_steps * self.step_m


def plan_gait(params: dict, path: TrajectoryPath) -> GaitPlan:
    intro = max(10, int(round(INTRO_S * HZ)))
    outro = max(10, int(round(OUTRO_S * HZ)))
    composite = params["pattern"] == "composite"
    max_frames = COMPOSITE_MAX_TOTAL_FRAMES if composite else MAX_TOTAL_FRAMES
    budget = max_frames - intro - outro

    step_len = params["step_length_m"]
    step_time = BASE_STEP_TIME[params["speed"]] * math.sqrt(step_len / STEP_TIME_REF_M)
    step_time = float(np.clip(step_time, STEP_TIME_MIN_S, STEP_TIME_MAX_S))
    step_frames_guess = max(8, int(round(step_time * HZ)))

    wanted_steps = max(4, int(round(path.total_length / step_len)))
    max_steps = max(4, budget // step_frames_guess)
    trimmed = wanted_steps > max_steps
    if composite:
        # keep every requested segment: walk the whole compound path and, if it
        # would run long, compress the cadence instead of cutting the path.
        n_steps = wanted_steps
        step_m = path.total_length / n_steps
        trimmed = False
    elif trimmed:
        n_steps = max_steps
        step_m = step_len
    else:
        n_steps = wanted_steps
        step_m = path.total_length / n_steps

    step_frames = max(8, int(round(step_time * HZ)))
    if n_steps * step_frames < int(MIN_MOTION_S * HZ):
        # stretch the cadence so a very short clip still reads as walking
        step_frames = int(math.ceil(MIN_MOTION_S * HZ / n_steps))
        step_frames = int(np.clip(step_frames, 8, int(STEP_TIME_MAX_S * HZ)))
    cadence_compressed = False
    if composite:
        if n_steps * step_frames > budget:
            step_frames = max(8, int(budget // n_steps))
            cadence_compressed = True
    else:
        step_frames = min(step_frames, budget // n_steps)

    duration = n_steps * step_frames * DT
    swing_h = float(np.clip(0.010 + 0.20 * step_m, SWING_HEIGHT_MIN, SWING_HEIGHT_MAX))
    return GaitPlan(
        n_steps=n_steps,
        step_m=float(step_m),
        step_frames=int(step_frames),
        intro_frames=intro,
        outro_frames=outro,
        swing_h=swing_h,
        duration_s=duration,
        total_frames=intro + n_steps * step_frames + outro,
        trimmed=trimmed,
        trimmed_from_laps=float(params.get("laps") or 0.0),
        path=path,
        cadence_compressed=cadence_compressed,
    )


# --------------------------------------------------------------------------- #
# clip authoring
# --------------------------------------------------------------------------- #
class Clip:
    def __init__(self):
        self.root_xy: list = []
        self.root_z: list = []
        self.yaw: list = []
        self.feet: list = []
        self.contact: list = []
        self.phase: list = []

    def add(self, root_xy, root_z, yaw, feet, contact, phase):
        self.root_xy.append(np.asarray(root_xy, float))
        self.root_z.append(float(root_z))
        self.yaw.append(float(yaw))
        self.feet.append(np.asarray(feet, float))
        self.contact.append(np.asarray(contact, float))
        self.phase.append(str(phase))

    def __len__(self):
        return len(self.yaw)


def build_clip(params: dict, plan: GaitPlan) -> Clip:
    """Author the root + both sole world targets for every 50 Hz frame.

    The gait is authored in a "travel frame" (x = direction of travel), so the
    forward and backward gaits share one trajectory: the backward gait merely
    faces the other way (yaw += pi) and swaps which side each sole sits on.
    That is what makes the backward hip swing real and geometry-checked.
    """
    path = plan.path
    backward = params["direction"] == "backward"
    dir_sign = -1.0 if backward else 1.0
    yaw_offset = math.pi if backward else 0.0
    lat = HOME_STANCE_HALF_WIDTH_M
    foot_lateral = {"left": dir_sign * lat, "right": -dir_sign * lat}

    step_m = plan.step_m
    swing_frac = SWING_END - SWING_START
    plant_offset = (1.0 - 0.5 * swing_frac) * step_m   # +-0.65 * step around root
    z0 = float(HOME_FOOT_Z) + STANCE_TARGET_LIFT_M
    root_z_base = plan_homez() - ROOT_CROUCH_M

    def foot_world(s_arc: float, side: int, z_target: float) -> np.ndarray:
        lat_s = foot_lateral["left"] if side == 0 else foot_lateral["right"]
        p = path.xy(s_arc) + path.left_normal(s_arc) * lat_s
        return np.array([p[0], p[1], z_target])

    # Steady-state stance for the first step (k=0 swings the left foot): the
    # left sole was planted two steps ago, the right sole one step ago.
    plant = [
        foot_world(plant_offset - 1.15 * step_m, 0, z0),
        foot_world(plant_offset - 0.15 * step_m, 1, z0),
    ]

    clip = Clip()
    root0 = path.xy(0.0)
    yaw0 = path.heading(0.0) + yaw_offset
    feet0 = np.stack([plant[0].copy(), plant[1].copy()])
    for _ in range(plan.intro_frames):
        clip.add(root0, root_z_base, yaw0, feet0, [1.0, 1.0], "intro_stand")

    for k in range(plan.n_steps):
        swing = k % 2
        stance = 1 - swing
        # world plant target for this swing foot, from its root-position offset
        plant_arc = (k + SWING_END) * step_m + plant_offset
        plant_new = foot_world(plant_arc, swing, z0)
        old_plant = plant[swing].copy()

        for f in range(plan.step_frames):
            u = f / plan.step_frames
            s_root = (k + u) * step_m
            root = path.xy(s_root)
            heading = path.heading(s_root)
            yaw = heading + yaw_offset

            # weight shift toward the support foot + subtle vertical bob
            support_sign = 1.0 if stance == 0 else -1.0
            pulse = math.sin(math.pi * (k + u)) ** 2
            sway = SWAY_AMP_M * support_sign * pulse
            root = root + path.left_normal(s_root) * (dir_sign * sway)
            root_z = root_z_base + BOB_AMP_M * (pulse - 0.5)

            # swinging foot: smooth world interpolation + sine lift
            if SWING_START <= u <= SWING_END:
                w = smooth((u - SWING_START) / swing_frac)
                target = old_plant + (plant_new - old_plant) * w
                target[2] = z0 + plan.swing_h * math.sin(math.pi * w)
                swing_feet = target
                contact = [1.0, 1.0]
                contact[swing] = 0.0
            else:
                swing_feet = plant_new if u > SWING_END else old_plant
                contact = [1.0, 1.0]

            feet = np.stack([plant[0].copy(), plant[1].copy()])
            feet[swing] = swing_feet
            clip.add(root, root_z, yaw, feet, contact,
                     f"step{k:02d}_" + ("left" if swing == 0 else "right"))
        plant[swing] = plant_new

    # settle: both feet planted, root holds at the final path point
    final_root = path.xy(plan.travel_m)
    final_heading = path.heading(plan.travel_m) + yaw_offset
    feet = np.stack([plant[0].copy(), plant[1].copy()])
    for _ in range(plan.outro_frames):
        clip.add(final_root, root_z_base, final_heading, feet, [1.0, 1.0], "outro_settle")
    return clip


# --------------------------------------------------------------------------- #
# single-foot hover ("单脚悬停")
# --------------------------------------------------------------------------- #
@dataclass
class HoverPath:
    """Stand-in for TrajectoryPath so reporting code stays pattern-agnostic."""
    kind: str = "hover"
    lap_length: float = 0.0
    total_length: float = 0.0


@dataclass
class HoverPlan:
    """Frame budget for the hover gesture (no travel, no steps)."""
    intro_frames: int
    lift_frames: int
    hold_frames: int
    lower_frames: int
    outro_frames: int
    duration_s: float
    total_frames: int
    lift_height_m: float
    hover_foot: str
    hold_s: float
    n_steps: int = 0
    step_m: float = 0.0
    step_frames: int = 0
    step_s: float = 0.0
    swing_h: float = 0.0
    travel_m: float = 0.0
    laps_effective: float = 1.0
    trimmed: bool = False
    cadence_compressed: bool = False
    path: HoverPath = field(default_factory=HoverPath)


def plan_hover(params: dict) -> HoverPlan:
    intro = max(10, int(round(INTRO_S * HZ)))
    outro = max(10, int(round(OUTRO_S * HZ)))
    lift = max(10, int(round(HOVER_LIFT_S * HZ)))
    lower = max(10, int(round(HOVER_LOWER_S * HZ)))
    hold = max(10, int(round(float(params["hold_s"]) * HZ)))
    budget = MAX_TOTAL_FRAMES - intro - outro
    if lift + hold + lower > budget:
        hold = max(10, budget - lift - lower)
    total = intro + lift + hold + lower + outro
    return HoverPlan(
        intro_frames=intro, lift_frames=lift, hold_frames=hold,
        lower_frames=lower, outro_frames=outro,
        duration_s=round(total * DT, 3), total_frames=total,
        lift_height_m=float(params["lift_height_m"]),
        hover_foot=str(params["hover_foot"]),
        hold_s=round(hold * DT, 2),
    )


def build_hover_clip(params: dict, plan: HoverPlan) -> Clip:
    """One sole planted, the other lifted and held (姿态类动作：无位移).

    The lowering ramp mirrors the lifting ramp waypoint by waypoint. That keeps
    the IK on the same solution branch on the way down; generating the two ramps
    independently made the solver pick a different branch on descent (self
    collision at the knee) for some lift/hold combinations.
    """
    foot = str(params["hover_foot"])          # the LIFTED (hovering) sole
    swing = 0 if foot == "left" else 1        # 0 = left sole, 1 = right sole
    support = 1 - swing
    lat = HOME_STANCE_HALF_WIDTH_M
    z0 = float(HOME_FOOT_Z) + max(STANCE_TARGET_LIFT_M, 0.0025)
    root_z = plan_homez() - ROOT_CROUCH_M
    root0 = np.zeros(2)
    feet_home = np.array([
        [0.0, +lat, z0],
        [0.0, -lat, z0],
    ])
    sway_dir = 1.0 if support == 0 else -1.0   # toward the support foot (+y = left)
    swing_phase = "left" if swing == 0 else "right"
    lift_h = float(plan.lift_height_m)

    clip = Clip()
    for _ in range(plan.intro_frames):
        clip.add(root0, root_z, 0.0, feet_home.copy(), [1.0, 1.0], "intro_stand")

    def add_at(weight: float, phase: str) -> None:
        feet = feet_home.copy()
        feet[swing, 2] = z0 + lift_h * weight
        feet[swing, 0] += HOVER_TUCK_X_M * weight
        feet[swing, 1] -= sway_dir * HOVER_TUCK_Y_M * weight
        root = root0 + np.array([0.0, sway_dir * HOVER_SWAY_M * weight])
        contact = [1.0, 1.0]
        contact[swing] = 0.0
        clip.add(root, root_z, 0.0, feet, contact, phase)

    lift_weights = [smooth((i + 1) / plan.lift_frames) for i in range(plan.lift_frames)]
    for weight in lift_weights:
        add_at(weight, f"lift_{swing_phase}")
    for _ in range(plan.hold_frames):
        add_at(1.0, f"hold_{swing_phase}")
    for weight in reversed(lift_weights):
        add_at(weight, f"lower_{swing_phase}")

    for _ in range(plan.outro_frames):
        clip.add(root0, root_z, 0.0, feet_home.copy(), [1.0, 1.0], "outro_settle")
    return clip


# HOME foot-site height / root height are filled in by author_motion() before
# build_clip via these module-level values (keeps build_clip signature small).
HOME_FOOT_Z: float = 0.0
_HOME_ROOT_Z: float = 0.0


def plan_homez() -> float:
    return _HOME_ROOT_Z


# --------------------------------------------------------------------------- #
# constrained IK (adapted from author_marseille_motion.solve)
# --------------------------------------------------------------------------- #
def solve_ik(modelb: ModelBundle, clip: Clip, margin_deg: float | None = None,
             cfg_override: dict | None = None) -> dict:
    import mujoco
    from scipy.optimize import least_squares
    from scipy.spatial.transform import Rotation

    m, d = modelb.m, modelb.d
    ids, names, qa, home = modelb.ids, modelb.names, modelb.qa, modelb.home
    feet_ids, homefeet = modelb.feet_ids, modelb.homefeet
    cfg = dict(RETARGET)
    if cfg_override:
        cfg.update(cfg_override)
    margin = math.radians(cfg["joint_margin_deg"] if margin_deg is None else margin_deg)

    legids = [i for i, n in enumerate(names) if any(v in n for v in ("hip", "knee", "ankle"))]
    lo = m.jnt_range[ids, 0] + margin
    hi = m.jnt_range[ids, 1] - margin
    q = home.copy()
    qprev = home.copy()
    # Sole orientation of the HOME pose expressed in the BODY frame. It must be
    # captured with an identity root orientation: frame 0 of a backward motion
    # already carries yaw=pi, and capturing it there would double-rotate the
    # desired sole orientation (that bug made backward hip_yaw saturate).
    d.qpos[:3] = [0.0, 0.0, modelb.homez]
    d.qpos[3:7] = [1.0, 0.0, 0.0, 0.0]
    d.qpos[qa] = home
    mujoco.mj_forward(m, d)
    homerots = d.site_xmat[feet_ids].reshape(2, 3, 3).copy()
    out_q, out_root, out_quat, out_feet, errors = [], [], [], [], []
    yaws = np.asarray(clip.yaw, float)
    roots = np.asarray(clip.root_xy, float)
    root_zs = np.asarray(clip.root_z, float)
    targets_all = np.asarray(clip.feet, float)

    for k in range(len(clip)):
        root = np.array([roots[k, 0], roots[k, 1], root_zs[k]])
        quat = Rotation.from_euler("z", float(yaws[k])).as_quat()[[3, 0, 1, 2]]
        targets = targets_all[k].copy()
        heading = Rotation.from_euler("z", float(yaws[k])).as_matrix()

        desired = heading[None] @ homerots

        def residual(x):
            q[legids] = x
            d.qpos[:3] = root
            d.qpos[3:7] = quat
            d.qpos[qa] = q
            mujoco.mj_forward(m, d)
            pos = (d.site_xpos[feet_ids] - targets).ravel() / cfg["ik_position_scale_m"]
            ori = []
            for side, f in enumerate(feet_ids):
                rv = Rotation.from_matrix(
                    desired[side].T @ d.site_xmat[f].reshape(3, 3)
                ).as_rotvec()
                # rv[0:2] keeps the sole flat; rv[2] (foot yaw about the sole
                # normal) is only softly constrained -- the robot has no ankle
                # yaw, so a hard yaw target would fight the position targets.
                ori.extend([rv[0] * cfg["ik_sole_orientation_weight"],
                            rv[1] * cfg["ik_sole_orientation_weight"],
                            rv[2] * cfg["ik_sole_yaw_weight"]])
            return np.r_[
                pos,
                ori,
                cfg["ik_smoothness_weight"] * (x - qprev[legids]),
                cfg["ik_posture_weight"] * (x - home[legids]),
            ]

        # Per-frame trust region: cap how far each joint may move between two
        # 50 Hz frames. This kills the occasional IK branch hop (a single-frame
        # 10+ rad/s spike) without constraining normal gait motion.
        delta = cfg.get("ik_max_frame_delta_rad", 0.0)
        if k > 0 and delta > 0.0:
            frame_lo = np.maximum(lo[legids], qprev[legids] - delta)
            frame_hi = np.minimum(hi[legids], qprev[legids] + delta)
        else:
            frame_lo, frame_hi = lo[legids], hi[legids]
        sol = least_squares(
            residual,
            np.clip(qprev[legids], frame_lo, frame_hi),
            bounds=(frame_lo, frame_hi),
            max_nfev=cfg["ik_max_evaluations"],
        )
        residual(sol.x)
        err = float(np.linalg.norm(d.site_xpos[feet_ids] - targets, axis=1).max())
        out_q.append(q.copy())
        out_root.append(root.copy())
        out_quat.append(np.asarray(quat, float).copy())
        out_feet.append(d.site_xpos[feet_ids].copy())
        errors.append(err)
        qprev = q.copy()

    return {
        "joint_pos": np.array(out_q),
        "root_pos": np.array(out_root),
        "root_quat_wxyz": np.array(out_quat),
        "feet_pos": np.array(out_feet),
        "ik_errors_m": np.array(errors),
    }


# --------------------------------------------------------------------------- #
# geometric inspection (mirrors mvi.robot.geometry, seconds-scale)
# --------------------------------------------------------------------------- #
def check_geometry(modelb: ModelBundle, motion: dict, verbose: bool = False) -> dict:
    import mujoco

    m, d = modelb.m, modelb.d
    ids, qa = modelb.ids, modelb.qa
    feet_ids, soles = modelb.feet_ids, modelb.soles
    colliding_ns = [g for g in modelb.colliding if g not in soles]
    q = np.asarray(motion["joint_pos"], float)
    t = np.asarray(motion["times"], float)
    roots = np.asarray(motion["root_pos"], float)
    quats = np.asarray(motion["root_quat_wxyz"], float)

    speed = np.abs(np.gradient(q, t, axis=0)) if len(q) > 1 else np.zeros_like(q)
    margin = np.minimum(q - m.jnt_range[ids, 0], m.jnt_range[ids, 1] - q)
    tol = CHECKS["penetration_tolerance_m"] * 1000.0  # mm

    hard_frames = 0
    reason_counts: dict[str, int] = {}
    min_margin = float("inf")
    max_speed = 0.0
    min_sole = float("inf")
    min_nonfoot = float("inf")
    self_total = 0
    worst: list[dict] = []

    for k in range(len(q)):
        d.qpos[:3] = roots[k]
        d.qpos[3:7] = quats[k]
        d.qpos[qa] = q[k]
        d.qvel[:] = 0.0
        mujoco.mj_forward(m, d)

        self_pen = 0
        for j in range(d.ncon):
            c = d.contact[j]
            if (m.geom_bodyid[c.geom1] > 0 and m.geom_bodyid[c.geom2] > 0
                    and c.dist < -CHECKS["penetration_tolerance_m"]):
                self_pen += 1
        self_total += self_pen
        sole_z = [geom_min_z(m, d, g) * 1000.0 for g in soles]
        nonfoot = min((geom_min_z(m, d, g) for g in colliding_ns), default=1.0) * 1000.0
        margin_deg = float(np.degrees(margin[k].min()))
        speed_k = float(speed[k].max())
        min_margin = min(min_margin, margin_deg)
        max_speed = max(max_speed, speed_k)
        min_sole = min(min_sole, min(sole_z))
        min_nonfoot = min(min_nonfoot, nonfoot)

        reasons = []
        if margin_deg < -1e-5:
            reasons.append(REASON_JOINT_LIMIT)
        if min(sole_z) < -tol or nonfoot < -tol:
            reasons.append(REASON_GROUND)
        if self_pen:
            reasons.append(REASON_SELF)
        if speed_k > CHECKS["maximum_joint_speed_rad_s"]:
            reasons.append(REASON_SPEED)
        if reasons:
            hard_frames += 1
            for r in reasons:
                reason_counts[r] = reason_counts.get(r, 0) + 1
            if len(worst) < 6:
                jl = int(np.argmin(margin[k]))
                worst.append({
                    "time_s": round(float(t[k]), 3),
                    "phase": motion["phases"][k],
                    "reasons": reasons,
                    "min_joint_margin_deg": round(margin_deg, 2),
                    "binding_joint": modelb.names[jl],
                    "max_joint_speed_rad_s": round(speed_k, 2),
                    "sole_z_mm": [round(v, 2) for v in sole_z],
                    "nonfoot_z_mm": round(nonfoot, 2),
                    "self_penetrating_contacts": self_pen,
                })

    # IK unreachability is a hard error in the video pipeline as well.
    ik_max_mm = float(np.asarray(motion["authoring"]["ik_errors_mm"], float).max())
    ik_bad = ik_max_mm > CHECKS["maximum_ik_foot_error_mm"]
    if ik_bad:
        reason_counts["Unreachable foot targets: IK error above tolerance"] = 1
        hard_frames += 1

    ok = not reason_counts
    return {
        "ok": bool(ok),
        "hard_error_count": int(hard_frames),
        "checks": {
            "min_joint_margin_deg": round(float(min_margin), 3),
            "max_joint_speed_rad_s": round(float(max_speed), 3),
            "min_sole_z_mm": round(float(min_sole), 3),
            "min_nonfoot_z_mm": round(float(min_nonfoot), 3),
            "self_penetrating_contacts": int(self_total),
        },
        "reason_counts": reason_counts,
        "worst_frames": worst,
        "ik": {
            "max_ik_foot_error_mm": round(ik_max_mm, 3),
            "median_ik_foot_error_mm": round(
                float(np.median(np.asarray(motion["authoring"]["ik_errors_mm"], float))), 3
            ),
            "tolerance_mm": CHECKS["maximum_ik_foot_error_mm"],
        },
        "model": str(modelb.xml_path),
    }


# --------------------------------------------------------------------------- #
# public authoring entry point
# --------------------------------------------------------------------------- #
@dataclass
class AuthorResult:
    params: dict
    effective_pattern: str
    effective_params: dict
    degraded: bool
    degrade_reason: str | None
    warnings: list
    motion: dict
    geometry: dict
    plan: GaitPlan
    path: TrajectoryPath
    timings_s: dict = field(default_factory=dict)

    def summary(self) -> dict:
        return {
            "effective_pattern": self.effective_pattern,
            "degraded": self.degraded,
            "degrade_reason": self.degrade_reason,
            "frames": len(self.motion["times"]),
            "motion_duration_s": self.motion["duration_s"],
            "geometry_ok": self.geometry["ok"],
            "checks": self.geometry["checks"],
        }


def _fallback_attempts(params: dict):
    """Ordered (params, reason) candidates after the requested pattern."""
    requested = dict(params)
    pattern = params["pattern"]
    step = params["step_length_m"]
    radius = float(params.get("radius_m") or 0.10)
    # Segment lists only make sense for `composite`; every degraded attempt is a
    # plain pattern, so it must not inherit them.
    base = {key: value for key, value in requested.items() if key != "segments"}
    attempts = []
    if pattern == "hover":
        lift = float(params.get("lift_height_m", 0.05))
        attempts.append(({**requested, "lift_height_m": min(lift, 0.03), "hold_s": 1.5},
                         f"该悬停姿态几何不可行，已降低抬脚高度到 {min(lift, 0.03):.2f} m 并缩短保持时间"))
    if pattern == "composite":
        # First try to make the COMPOUND shape feasible by opening the turn
        # radii (still the same choreography), before falling back to an arc.
        base_segments = list(params.get("segments") or [])
        for bump, step_scale in ((0.02, 1.0), (0.05, 0.9)):
            tuned = []
            for seg in base_segments:
                if seg.get("kind") == "turn":
                    tuned.append({**seg,
                                  "radius_m": round(min(SEGMENT_TURN_RADIUS_RANGE[1],
                                                        float(seg["radius_m"]) + bump), 4)})
                else:
                    tuned.append(dict(seg))
            candidate = {**requested, "segments": tuned,
                         "step_length_m": float(np.clip(step * step_scale, 0.02, 0.06))}
            attempts.append((candidate,
                             f"复合轨迹几何不可行，已将转弯半径整体 +{bump * 100:.0f} cm"
                             f"{'、步长缩短 10%' if step_scale < 1 else ''} 后重试"))
        turns = [seg for seg in base_segments if seg.get("kind") == "turn"]
        turn_radius = max((float(seg["radius_m"]) for seg in turns), default=0.12)
        attempts.append(({**base, "pattern": "arc", "radius_m": max(turn_radius, 0.10)},
                         f"复合轨迹在该机器人上几何不可行，已降级为同半径圆弧行走 "
                         f"(arc, R={max(turn_radius, 0.10):.2f} m)"))
    if pattern == "figure8":
        attempts.append(({**requested, "pattern": "arc", "radius_m": max(radius, 0.10)},
                         f"figure8 在该机器人上几何不可行，已降级为同半径圆弧转向 (arc, R={max(radius, 0.10):.2f} m)"))
        attempts.append(({**requested, "pattern": "arc", "radius_m": 0.15},
                         "figure8 降级失败，改用大半径圆弧 (arc, R=0.15 m)"))
    elif pattern == "arc":
        attempts.append(({**requested, "radius_m": max(radius, 0.10)},
                         f"该半径圆弧几何不可行，已增大半径到 {max(radius, 0.10):.2f} m"))
        attempts.append(({**requested, "radius_m": 0.15},
                         "增大半径仍不可行，改用 R=0.15 m 圆弧"))
    # last resort for any pattern: a gentler forward arc
    attempts.append(({**base, "pattern": "arc", "radius_m": 0.15,
                      "step_length_m": float(np.clip(step * 0.8, 0.02, 0.06))},
                     "请求动作几何不可行，已降级为温和圆弧行走 (arc, R=0.15 m, 步长缩短 20%)"))
    # de-duplicate on the fields that shape the motion
    seen, unique = set(), []
    for cand, reason in attempts:
        seg_sig = tuple((s.get("kind"), round(float(s.get("length_m") or 0.0), 4),
                         round(float(s.get("turn_deg") or 0.0), 3),
                         round(float(s.get("radius_m") or 0.0), 4))
                        for s in (cand.get("segments") or []))
        key = (cand["pattern"], round(float(cand.get("radius_m") or 0.0), 4),
               round(cand["step_length_m"], 4), cand["direction"], cand["speed"], seg_sig)
        if key in seen:
            continue
        seen.add(key)
        unique.append((cand, reason))
    return unique


def _describe_failure(geometry: dict, limit: int = 2) -> str:
    """Human-readable 'which frame / joint / by how much' failure summary."""
    parts = []
    counts = geometry.get("reason_counts", {})
    if counts:
        parts.append("检查不通过: " + ", ".join(f"{k}×{v}" for k, v in counts.items()))
    for w in (geometry.get("worst_frames") or [])[:limit]:
        parts.append(
            f"第{int(round(w['time_s'] * HZ))}帧({w['time_s']:.2f}s,{w['phase']}) "
            f"{'/'.join(w['reasons'])}: {w['binding_joint']} 关节余量 {w['min_joint_margin_deg']:.1f}°, "
            f"峰值关节速度 {w['max_joint_speed_rad_s']:.1f} rad/s, "
            f"鞋底最低 {min(w['sole_z_mm']):.2f} mm, 自穿模接触 {w['self_penetrating_contacts']}"
        )
    return "；".join(parts)


def _pattern_label(p: dict) -> str:
    if p.get("pattern") == "hover":
        return (f"hover({'左脚' if p.get('hover_foot') == 'left' else '右脚'}抬起 "
                f"{float(p.get('lift_height_m', 0.05)) * 100:.0f}cm · 保持 "
                f"{float(p.get('hold_s', 2.5)):g}s)")
    if p.get("pattern") == "composite":
        parts = []
        for seg in p.get("segments") or []:
            if seg.get("kind") == "straight":
                parts.append(f"直行{seg['length_m']*1000:.0f}mm")
            else:
                side = "左转" if float(seg["turn_deg"]) >= 0 else "右转"
                parts.append(f"{side}{abs(float(seg['turn_deg'])):.0f}°(R={float(seg['radius_m']):.2f}m)")
        return (f"composite({'→'.join(parts)}, 步长={p['step_length_m'] * 1000:.0f}mm, "
                f"{p['direction']}, {p['speed']})")
    return (f"{p['pattern']}(R={p['radius_m']:.2f}m, 步长={p['step_length_m'] * 1000:.0f}mm, "
            f"{p['direction']}, {p['speed']})")


def _build_motion(params: dict, plan, path, clip, ik, modelb: ModelBundle, ik_s: float) -> dict:
    """Assemble the motion.json payload from an authored clip + IK solution."""
    times = np.arange(len(clip)) * DT
    errors_mm = ik["ik_errors_m"] * 1000.0
    return {
        "schema_version": 1,
        "name": f"Microduck authored preview: {params['pattern']} {params['direction']}",
        "method": (
            "parameterised root/foot trajectories authored against the real robot limits; "
            "both sole poses solved per frame by constrained least-squares IK "
            "(no video input, no training)"
        ),
        "joint_names": list(modelb.names),
        "times": times.tolist(),
        "joint_pos": ik["joint_pos"].tolist(),
        "root_pos": ik["root_pos"].tolist(),
        "root_quat_wxyz": ik["root_quat_wxyz"].tolist(),
        "feet_pos": ik["feet_pos"].tolist(),
        "contact": np.asarray(clip.contact, float).tolist(),
        "home_joint_pos": modelb.home.tolist(),
        "home_root_pos": np.array([0.0, 0.0, float(modelb.homez)]).tolist(),
        "duration_s": float(times[-1]),
        "entrance_s": 0.0,
        "clip_duration_s": float(times[-1]),
        "recovery_s": 0.0,
        "control_hz": HZ,
        "phases": clip.phase,
        "params": dict(params),
        "authoring": {
            "step_length_m": plan.step_m,
            "step_length_requested_m": params["step_length_m"],
            "step_duration_s": plan.step_s,
            "swing_height_m": plan.swing_h,
            "n_steps": plan.n_steps,
            "travel_m": plan.travel_m,
            "laps_requested": params.get("laps"),
            "laps_effective": plan.laps_effective,
            "trimmed_for_time_budget": plan.trimmed,
            "cadence_compressed": plan.cadence_compressed,
            "path_kind": path.kind,
            "path_lap_length_m": path.lap_length,
            "path_total_length_m": path.total_length,
            "segments": params.get("segments"),
            "hover_foot": params.get("hover_foot"),
            "lift_height_m": params.get("lift_height_m"),
            "hold_s": params.get("hold_s"),
            "max_ik_foot_error_mm": float(errors_mm.max()),
            "ik_errors_mm": errors_mm.tolist(),
        },
    }


def _hover_candidates(params: dict) -> list[dict]:
    """The requested hover plus small lift nudges.

    The IK occasionally settles into a different (tighter) solution branch for a
    specific lift height, which shows up as a ~2 deg joint margin or a knee
    self-collision on the way down. Trying a few nearby heights costs a couple of
    seconds and makes the gesture robust for every requested value.
    """
    base = float(params["lift_height_m"])
    low, high = HOVER_LIFT_RANGE_M
    candidates = [dict(params)]
    for delta in (0.004, -0.004, 0.008, -0.008):
        value = round(min(high, max(low, base + delta)), 4)
        if all(abs(value - float(c["lift_height_m"])) > 1e-9 for c in candidates):
            candidates.append({**params, "lift_height_m": value})
    return candidates


HOVER_ACCEPT_MARGIN_DEG = 6.0


def _author_once(params: dict, modelb: ModelBundle) -> tuple[dict, dict, GaitPlan, TrajectoryPath, dict]:
    global HOME_FOOT_Z, _HOME_ROOT_Z
    HOME_FOOT_Z = float(modelb.homefeet[0, 2])
    _HOME_ROOT_Z = float(modelb.homez)

    candidates = _hover_candidates(params) if params["pattern"] == "hover" else [params]
    best = None
    total_ik_s = 0.0
    for candidate in candidates:
        if candidate["pattern"] == "hover":
            plan = plan_hover(candidate)
            path = plan.path
            clip = build_hover_clip(candidate, plan)
        else:
            path = make_path(candidate["pattern"], float(candidate.get("radius_m") or 0.10),
                             float(candidate.get("laps") or 1.0), candidate.get("segments"))
            plan = plan_gait(candidate, path)
            clip = build_clip(candidate, plan)
        if abs(plan_homez() - float(modelb.homez)) > 1e-12:  # pragma: no cover
            raise AuthorError("内部错误：HOME root 高度未初始化")

        t0 = time.time()
        ik = solve_ik(modelb, clip)
        ik_s = time.time() - t0
        total_ik_s += ik_s
        motion = _build_motion(candidate, plan, path, clip, ik, modelb, ik_s)
        geometry = check_geometry(modelb, motion)
        margin = float(geometry["checks"]["min_joint_margin_deg"])
        score = (1 if geometry["ok"] else 0, margin)
        if best is None or score > best[0]:
            best = (score, candidate, motion, geometry, plan, path)
        if geometry["ok"] and margin >= HOVER_ACCEPT_MARGIN_DEG:
            break

    _, chosen, motion, geometry, plan, path = best
    timings = {"ik_s": round(total_ik_s, 2)}
    if chosen is not params and float(chosen["lift_height_m"]) != float(params["lift_height_m"]):
        timings["hover_lift_adjusted_from_m"] = float(params["lift_height_m"])
    return motion, geometry, plan, path, timings


def author_motion(params: dict) -> AuthorResult:
    """Author the closest feasible motion to the requested params."""
    t_start = time.time()
    params = validate_params(params)
    modelb = build_model()
    warnings: list[str] = []
    warnings.extend(_SEGMENT_WARNINGS)
    attempts = [(dict(params), None)] + _fallback_attempts(params)

    failures = []
    for attempt_index, (attempt_params, degrade_reason) in enumerate(attempts):
        motion, geometry, plan, path, timings = _author_once(attempt_params, modelb)
        if geometry["ok"]:
            degraded = attempt_index > 0
            if degraded:
                first_failure = failures[0][1] if failures else geometry
                detail = _describe_failure(first_failure)
                degrade_reason = (
                    f"请求的 {_pattern_label(params)} 几何不可行（{detail}）。"
                    f"已降级为 {_pattern_label(attempt_params)}。"
                )
                warnings.append(degrade_reason)
            if plan.trimmed:
                laps_req = params.get("laps")
                warnings.append(
                    f"为控制渲染时长，轨迹已截短到 {plan.laps_effective:.2f} 圈 "
                    + (f"(请求 {laps_req:g} 圈, " if laps_req else "(")
                    + f"实际 {plan.travel_m:.2f} m)"
                )
            if plan.cadence_compressed:
                warnings.append(
                    f"复合轨迹总长 {path.total_length:.2f} m 较长，已压缩步频以把成片控制在 20 s 内"
                    "（所有直行/转弯段均保留，未截短路径）"
                )
            if plan.path.kind == "hover":
                warnings.append(
                    f"单脚悬停：{'左' if params.get('hover_foot') == 'left' else '右'}脚抬起 "
                    f"{plan.lift_height_m * 100:.1f} cm 并保持 {plan.hold_s:g}s（另一只脚支撑）；"
                    "预览为运动学姿态（无动力学平衡仿真）"
                )
                if geometry["checks"]["min_joint_margin_deg"] < 5.0:
                    warnings.append(
                        f"该抬脚高度下关节余量仅 "
                        f"{geometry['checks']['min_joint_margin_deg']:.1f}°（接近限位）；"
                        "建议 lift_height_m 用 0.05（实测余量约 9°）"
                    )
            if plan.path.kind == "composite":
                turns = sum(1 for s in (params.get("segments") or []) if s.get("kind") == "turn")
                warnings.append(
                    f"复合轨迹：{len(params.get('segments') or [])} 段（{turns} 次转弯曲率连续 C1），"
                    f"总长 {path.total_length:.2f} m，每步机身转角 ≈ 弧长/半径，与已验证的 arc 同一量级"
                )
            if plan.path.kind == "figure8":
                warnings.append(
                    "figure8 由两段外相切圆弧构成（左右两叶，切点处朝向连续、曲率反号）；"
                    "每步机身转角与已验证的 arc 同一量级，已通过几何检查"
                )
            elif plan.path.kind == "arc":
                warnings.append("弧线行走时支撑脚在原地随身体旋转（预览级运动学，无打滑动力学）")
            if params["direction"] == "backward":
                warnings.append("后退步态为前后对称的'倒走'：脚向身体后方摆、髋关节后摆，已通过几何检查")
            return AuthorResult(
                params=params,
                effective_pattern=attempt_params["pattern"],
                effective_params=dict(attempt_params),
                degraded=degraded,
                degrade_reason=degrade_reason,
                warnings=warnings,
                motion=motion,
                geometry=geometry,
                plan=plan,
                path=path,
                timings_s={**timings, "authoring_total_s": round(time.time() - t_start, 2)},
            )
        failures.append((attempt_params, geometry))

    detail = failures[-1][1]["reason_counts"] if failures else {}
    raise AuthorError(
        "该参数下 Microduck 无法生成通过几何检查的动作 "
        f"(失败原因: {json.dumps(detail, ensure_ascii=False)})，请尝试减小步长或增大半径"
    )


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def authoring_report(result: AuthorResult, extra: dict | None = None) -> dict:
    """Stable report consumed by the plugin host / integration checks."""
    report = {
        "params": result.params,
        "effective_params": result.effective_params,
        "effective_pattern": result.effective_pattern,
        "degraded": result.degraded,
        "degrade_reason": result.degrade_reason,
        "warnings": list(result.warnings),
        "geometry": result.geometry,
        "timings_s": dict(result.timings_s),
        "plan": {
            "n_steps": result.plan.n_steps,
            "step_m": result.plan.step_m,
            "step_frames": result.plan.step_frames,
            "total_frames": result.plan.total_frames,
            "duration_s": result.plan.duration_s,
            "lap_length_m": result.path.lap_length,
            "travel_m": result.plan.travel_m,
            "path_total_length_m": result.path.total_length,
            "laps_effective": result.plan.laps_effective,
            "trimmed": result.plan.trimmed,
            "cadence_compressed": result.plan.cadence_compressed,
            "segments": (result.effective_params.get("segments")
                         if result.effective_pattern == "composite" else None),
        },
    }
    if extra:
        report["timings_s"] = {**report["timings_s"], **extra}
    return report


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Author a Microduck walk/arc/figure8 reference")
    ap.add_argument("--params-json", type=Path, help="JSON file with duck_preview params")
    ap.add_argument("--out-dir", type=Path, help="directory for motion.json + authoring_report.json")
    ap.add_argument("--pattern", default="line", choices=PATTERNS)
    ap.add_argument("--direction", default="forward", choices=DIRECTIONS)
    ap.add_argument("--step-length", type=float, default=0.04)
    ap.add_argument("--radius", type=float, default=0.10)
    ap.add_argument("--laps", type=float, default=1.0)
    ap.add_argument("--speed", default="normal", choices=SPEEDS)
    args = ap.parse_args(argv)

    if args.params_json:
        raw = json.loads(Path(args.params_json).read_text(encoding="utf-8"))
    else:
        raw = {
            "pattern": args.pattern,
            "direction": args.direction,
            "step_length_m": args.step_length,
            "radius_m": args.radius,
            "laps": args.laps,
            "speed": args.speed,
        }
    try:
        t0 = time.time()
        result = author_motion(raw)
        elapsed = time.time() - t0
        out = Path(args.out_dir) if args.out_dir else Path.cwd()
        write_json(out / "motion.json", result.motion)
        write_json(out / "authoring_report.json",
                   authoring_report(result, {"authoring_cli_s": round(elapsed, 2)}))
        summary = result.summary()
        summary["authoring_seconds"] = round(elapsed, 2)
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0
    except AuthorError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
