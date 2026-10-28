#!/usr/bin/env python3
"""Build a per-frame command table from authored motion.json."""
from __future__ import annotations

import math
from typing import Any

import numpy as np


def _yaw_from_quat(quat) -> float:
    w, x, y, z = [float(v) for v in quat]
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def _unwrap(values: np.ndarray) -> np.ndarray:
    out = np.unwrap(np.asarray(values, float))
    return out


def _support(contact) -> str:
    left, right = float(contact[0]) > 0.5, float(contact[1]) > 0.5
    if left and right:
        return "both"
    if left:
        return "left"
    if right:
        return "right"
    return "none"


def _phase_kind(phase: str) -> str:
    label, _, name = str(phase).partition("|")
    if not name: name = label
    if name == "transition": return "transition"
    if ":turn" in label: return "turn"
    if ":hover" in label and not name.startswith(("intro", "outro")): return "hover"
    if ":stand" in label: return "stand"
    if name.startswith("intro") or name.startswith("outro") or name.startswith("stand"):
        return "stand"
    if "hold" in name or name.startswith("lift") or name.startswith("lower"):
        return "hover"
    if name.startswith("step"):
        return "walk"
    return "other"


def command_from_motion(motion: dict[str, Any]) -> dict[str, Any]:
    times = np.asarray(motion["times"], float)
    root = np.asarray(motion["root_pos"], float)
    quat = np.asarray(motion["root_quat_wxyz"], float)
    contact = np.asarray(motion["contact"], float)
    phases = list(motion.get("phases") or ["walk"] * len(times))
    hz = float(motion.get("control_hz") or 50)
    if len(times) < 2 or np.any(np.diff(times) <= 0): raise ValueError("motion times 必须递增且至少两帧")
    yaw = _unwrap(np.array([_yaw_from_quat(q) for q in quat]))
    vx = np.zeros(len(times))
    wz = np.zeros(len(times))
    if len(times) > 1:
        dxy = np.diff(root[:, :2], axis=0)
        forward = np.stack([np.cos(yaw[1:]), np.sin(yaw[1:])], axis=1)
        vx[1:] = np.sum(dxy * forward, axis=1) / np.diff(times)
        wz[1:] = np.diff(yaw) / np.diff(times)
    support = [_support(row) for row in contact]
    kinds = [_phase_kind(phase) for phase in phases]
    segments = []
    start = 0
    for index in range(1, len(kinds) + 1):
        if index == len(kinds) or kinds[index] != kinds[start]:
            segments.append({
                "kind": kinds[start],
                "t0": float(times[start]),
                "t1": float(times[index - 1]),
                "support": support[start],
            })
            start = index
    return {
        "schema_version": 1,
        "control_hz": hz,
        "times": times.tolist(),
        "lin_vel_x": [round(float(v), 4) for v in vx],
        "ang_vel_z": [round(float(v), 4) for v in wz],
        "phase": kinds,
        "stage_label": [p.split("|")[0] if "|" in p else k for p,k in zip(phases,kinds)],
        "support_foot": support,
        "source_phases": phases,
        "segments": segments,
        "params": motion.get("params"),
        "note": "指令来自运动学参考轨迹的有限差分，不是训练环境抽样命令。",
    }
