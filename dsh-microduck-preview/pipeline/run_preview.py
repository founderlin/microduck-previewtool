#!/usr/bin/env python3
"""One-shot Microduck preview pipeline: author -> geometry -> render -> outputs.

INTERFACE (the DSH plugin Host calls exactly this):

    <python> pipeline/run_preview.py --params-json <params.json> --out-dir <dir>

It writes, into <dir>:

    preview.mp4   H.264 / yuv420p, ~25 fps, 1120x640, +faststart
    metrics.json  schema v1 (params echo, frame counts, geometry verdict, warnings)
    motion.json   50 Hz authored motion (debug/evidence; not required by the Host)

and exits 0 on success.  On an unrecoverable failure it exits non-zero and the
LAST stderr line is one human-readable sentence ("ERROR: ..."); no fake or empty
mp4 is ever left behind.

The heavy lifting (trajectories, constrained IK, geometric inspection) lives in
``author_walk.py`` next to this file and needs only mujoco/numpy/scipy, all of
which are present in the verified interpreter (see README).

Env overrides:
    MICRODUCK_ASSET_ROOT   microduck-marseille checkout root (models/scripts)
    MICRODUCK_PYTHON       accepted for compatibility; this pipeline runs
                           in-process, so no subprocess interpreter is needed.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

# rendering / packaging settings
FPS = 25
RENDER_STRIDE = 2            # keep every 2nd 50 Hz frame -> 25 fps
FRAME_W = 1120
FRAME_H = 640
HEADER_H = 36
FOOTER_H = 34
BODY_H = FRAME_H - HEADER_H - FOOTER_H
FOLLOW_W = 740
MINIMAP_W = FRAME_W - FOLLOW_W
CAM_BASE_AZIMUTH_DEG = 135.0
CAM_ELEVATION_DEG = -20.0
CAM_DISTANCE_M = 0.54
CAM_LOOKAT_Z_M = 0.105
CAM_AZIMUTH_SMOOTHING = 0.18

FONT_CANDIDATES = (
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 19),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", 19),
    ("/System/Library/Fonts/Helvetica.ttc", 19),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 19),
)

COL_BG = (18, 18, 20)
COL_PANEL = (24, 26, 30)
COL_GRID = (44, 48, 54)
COL_TEXT = (240, 240, 240)
COL_DIM = (150, 156, 164)
COL_ACCENT = (255, 176, 64)
COL_PATH = (96, 104, 116)
COL_START = (120, 220, 120)
COL_TRAIL = (255, 150, 60)
COL_WARN = (255, 210, 100)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def iso_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_font():
    from PIL import ImageFont

    for path, size in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def yaw_deg_wxyz(quat_wxyz) -> float:
    w, x, y, z = [float(v) for v in quat_wxyz]
    return float(math.degrees(math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))))


def unwrap_degrees(values) -> list[float]:
    out: list[float] = []
    for i, raw in enumerate(values):
        deg = float(math.degrees(raw))
        if i:
            while deg - out[-1] > 180.0:
                deg -= 360.0
            while deg - out[-1] < -180.0:
                deg += 360.0
        out.append(deg)
    return out


# --------------------------------------------------------------------------- #
# 3D follow-pane renderer (MuJoCo)
# --------------------------------------------------------------------------- #
# Checkerboard ground (same values as pipeline/frame_server.py so the live viewer
# and the recorded mp4 share one scene look).
CHECKER_RGB1 = (0.86, 0.87, 0.88)
CHECKER_RGB2 = (0.30, 0.32, 0.35)
CHECKER_REPEAT = 8
CHECKER_HALF_EXTENT_M = 2.0


def add_checker_floor(spec, mujoco, *, repeat: int = CHECKER_REPEAT,
                      half_extent: float = CHECKER_HALF_EXTENT_M,
                      rgb1=CHECKER_RGB1, rgb2=CHECKER_RGB2):
    """Add a checkerboard ground to an MjSpec scene.

    The colour texture must occupy the ``mjTEXROLE_RGB`` slot (value 1, not 0),
    and a plane geom has degenerate UVs, so the ground is a thin box slab whose
    top face sits exactly at z = 0.
    """
    texture = spec.add_texture()
    texture.name = "checker_floor_texture"
    texture.type = mujoco.mjtTexture.mjTEXTURE_2D
    texture.builtin = mujoco.mjtBuiltin.mjBUILTIN_CHECKER
    texture.rgb1 = list(rgb1)
    texture.rgb2 = list(rgb2)
    texture.width = 512
    texture.height = 512

    material = spec.add_material()
    material.name = "checker_floor_material"
    roles = [""] * 10
    roles[int(mujoco.mjtTextureRole.mjTEXROLE_RGB)] = texture.name
    material.textures = roles
    material.texrepeat = [repeat, repeat]
    material.texuniform = True

    floor = spec.worldbody.add_geom()
    floor.name = "checker_floor"
    floor.type = mujoco.mjtGeom.mjGEOM_BOX
    floor.size = [half_extent, half_extent, 0.02]
    floor.pos = [0.0, 0.0, -0.02]
    floor.material = material.name
    return floor


class FollowRenderer:
    """Offscreen MuJoCo renderer of the full duck, one follow-cam pane."""

    def __init__(self, asset_xml: Path, width: int = FOLLOW_W, height: int = BODY_H,
                 shadows: bool = True):
        import mujoco

        self._mj = mujoco
        spec = mujoco.MjSpec.from_file(str(asset_xml))
        # A checkerboard ground slab + two soft lights: the raw robot XML carries
        # no scene, and a plain grey void makes depth/scale hard to read.
        add_checker_floor(spec, mujoco)
        for pos, direction, diffuse, cast_shadow in (
            ([0.5, -0.6, 1.3], [-0.25, 0.35, -1.0], [0.75, 0.75, 0.72], True),
            ([-0.5, 0.7, 1.1], [0.2, -0.4, -1.0], [0.55, 0.56, 0.60], False),
        ):
            light = spec.worldbody.add_light()
            light.pos = list(pos)
            light.dir = list(direction)
            light.diffuse = list(diffuse)
            light.specular = [0.15, 0.15, 0.15]
            light.castshadow = bool(cast_shadow)
        self.model = spec.compile()
        self.model.vis.global_.offwidth = max(width + 20, 800)
        self.model.vis.global_.offheight = max(height + 20, 600)
        self.data = mujoco.MjData(self.model)
        self.renderer = mujoco.Renderer(self.model, height=height, width=width)
        if not shadows:
            self.renderer.scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = False
        self.cam = mujoco.MjvCamera()
        self.cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        self.cam.distance = CAM_DISTANCE_M
        self.cam.elevation = CAM_ELEVATION_DEG

    def close(self) -> None:
        try:
            self.renderer.close()
        except Exception:
            pass

    def render_frame(self, qpos_root, quat_wxyz, joint_pos, joint_names,
                     root_xy_z, azimuth_deg: float):
        mj = self._mj
        data = self.data
        data.qpos[:3] = qpos_root
        data.qpos[3:7] = quat_wxyz
        for name, value in zip(joint_names, joint_pos):
            data.qpos[self.model.joint(name).qposadr[0]] = value
        data.qvel[:] = 0.0
        mj.mj_forward(self.model, data)
        self.cam.azimuth = float(azimuth_deg)
        self.cam.lookat[:] = [float(root_xy_z[0]), float(root_xy_z[1]), CAM_LOOKAT_Z_M]
        self.renderer.update_scene(data, camera=self.cam)
        return self.renderer.render()


# --------------------------------------------------------------------------- #
# 2D top-down minimap pane (PIL)
# --------------------------------------------------------------------------- #
class Minimap:
    """Top-down world map: requested path, travelled trail, duck marker."""

    def __init__(self, path_xy, root_xy, width: int = MINIMAP_W, height: int = BODY_H,
                 font=None):
        self.w = width
        self.h = height
        self.font = font
        all_pts = []
        if len(path_xy):
            all_pts.append(path_xy)
        if len(root_xy):
            all_pts.append(root_xy)
        pts = []
        for arr in all_pts:
            for p in arr:
                pts.append((float(p[0]), float(p[1])))
        xs = [p[0] for p in pts] or [0.0]
        ys = [p[1] for p in pts] or [0.0]
        xmin, xmax = min(xs), max(xs)
        ymin, ymax = min(ys), max(ys)
        pad = 0.05
        xmin, xmax = xmin - pad, xmax + pad
        ymin, ymax = ymin - pad, ymax + pad
        margin_px = 30
        avail_w = width - 2 * margin_px
        avail_h = height - 2 * margin_px - 26  # leave room for the caption strip
        span_x = max(xmax - xmin, 1e-6)
        span_y = max(ymax - ymin, 1e-6)
        self.scale = min(avail_w / span_x, avail_h / span_y)
        self.cx = (xmin + xmax) / 2.0
        self.cy = (ymin + ymax) / 2.0
        self.ox = width / 2.0
        self.oy = (height - 26) / 2.0 + 8

    def to_px(self, x: float, y: float) -> tuple[float, float]:
        return (self.ox + (x - self.cx) * self.scale, self.oy - (y - self.cy) * self.scale)

    def _background(self):
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (self.w, self.h), COL_PANEL)
        dr = ImageDraw.Draw(img)
        # metric grid (0.1 m)
        if self.scale > 0:
            step_m = 0.1
            while step_m * self.scale < 34:  # keep grid readable
                step_m *= 2
            # grid extent from world bounds
            half_w = (self.w / 2.0) / self.scale
            half_h = ((self.h - 26) / 2.0) / self.scale
            x0 = math.floor((self.cx - half_w) / step_m) * step_m
            y0 = math.floor((self.cy - half_h) / step_m) * step_m
            gx = x0
            while gx <= self.cx + half_w:
                px, _ = self.to_px(gx, 0.0)
                dr.line([(px, 0), (px, self.h - 26)], fill=COL_GRID, width=1)
                gx += step_m
            gy = y0
            while gy <= self.cy + half_h:
                _, py = self.to_px(0.0, gy)
                dr.line([(0, py), (self.w, py)], fill=COL_GRID, width=1)
                gy += step_m
        if self.font:
            dr.text((10, 8), "TOP VIEW · world", fill=COL_TEXT, font=self.font)
        return img

    def render(self, path_xy, trail_xy, heading_deg: float, step_label: str):
        from PIL import ImageDraw

        img = self._background()
        dr = ImageDraw.Draw(img)
        # requested path (dashed-ish polyline)
        if len(path_xy) > 1:
            pts = [self.to_px(p[0], p[1]) for p in path_xy]
            dr.line(pts, fill=COL_PATH, width=2)
        # travelled trail
        if len(trail_xy) > 1:
            for i in range(1, len(trail_xy)):
                p0 = self.to_px(trail_xy[i - 1][0], trail_xy[i - 1][1])
                p1 = self.to_px(trail_xy[i][0], trail_xy[i][1])
                dr.line([p0, p1], fill=COL_TRAIL, width=3)
        if len(trail_xy):
            start = self.to_px(trail_xy[0][0], trail_xy[0][1])
            dr.ellipse([start[0] - 4, start[1] - 4, start[0] + 4, start[1] + 4],
                       outline=COL_START, width=2)
        if len(trail_xy):
            x, y = trail_xy[-1][0], trail_xy[-1][1]
            px, py = self.to_px(x, y)
            heading_rad = math.radians(heading_deg)
            # heading arrow points along the duck's facing (body +x)
            tip = (px + math.cos(heading_rad) * 15.0, py - math.sin(heading_rad) * 15.0)
            left = (px + math.cos(heading_rad + 2.5) * 11.0, py - math.sin(heading_rad + 2.5) * 11.0)
            right = (px + math.cos(heading_rad - 2.5) * 11.0, py - math.sin(heading_rad - 2.5) * 11.0)
            dr.polygon([tip, left, right], fill=COL_ACCENT)
            dr.ellipse([px - 3, py - 3, px + 3, py + 3], fill=(255, 255, 255))
        # scale bar
        bar_m = 0.1
        while bar_m * self.scale < 40:
            bar_m *= 2
        bar_px = bar_m * self.scale
        bx, by = 12, self.h - 16
        dr.line([(bx, by), (bx + bar_px, by)], fill=COL_DIM, width=2)
        dr.line([(bx, by - 3), (bx, by + 3)], fill=COL_DIM, width=2)
        dr.line([(bx + bar_px, by - 3), (bx + bar_px, by + 3)], fill=COL_DIM, width=2)
        if self.font:
            dr.text((bx + bar_px + 8, by - 9), f"{bar_m:g} m", fill=COL_DIM, font=self.font)
            dr.text((10, self.h - 44), step_label, fill=COL_DIM, font=self.font)
        return img


# --------------------------------------------------------------------------- #
# ffmpeg helpers (video encoder comes from imageio-ffmpeg)
# --------------------------------------------------------------------------- #
def ffmpeg_exe() -> str | None:
    try:
        from imageio_ffmpeg import get_ffmpeg_exe

        return get_ffmpeg_exe()
    except Exception:
        return None


def finalize_video(raw_path: Path, out_path: Path) -> dict:
    """Remux the encoder output to a browser-friendly, faststart mp4."""
    exe = ffmpeg_exe()
    info = {"codec": "h264", "pix_fmt": "yuv420p", "faststart": False}
    if exe:
        try:
            proc = subprocess.run(
                [exe, "-y", "-loglevel", "error", "-i", str(raw_path),
                 "-c", "copy", "-movflags", "+faststart", str(out_path)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            if proc.returncode == 0 and out_path.is_file() and out_path.stat().st_size > 0:
                info["faststart"] = True
                raw_path.unlink(missing_ok=True)
                return info
        except Exception:
            pass
    # fall back: move the raw file into place (still valid h264/yuv420p)
    raw_path.replace(out_path)
    return info


def probe_video(path: Path) -> dict | None:
    """Best-effort ffmpeg -i inspection (for the metrics/diagnostics)."""
    exe = ffmpeg_exe()
    if not exe:
        return None
    try:
        proc = subprocess.run([exe, "-i", str(path)], capture_output=True, text=True)
        text = proc.stderr
        line = next((ln.strip() for ln in text.splitlines() if "Stream #" in ln and "Video:" in ln), "")
        dur = next((ln.strip() for ln in text.splitlines() if "Duration:" in ln), "")
        return {"stream": line, "duration": dur}
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# rendering
# --------------------------------------------------------------------------- #
def render_preview(motion: dict, author_result, out_dir: Path, verbose: bool = False) -> dict:
    import numpy as np
    from PIL import Image, ImageDraw

    t_start = time.time()
    import author_walk

    asset_xml = author_walk.resolve_asset_root() / author_walk.ROBOT_XML_REL
    times = np.asarray(motion["times"], float)
    joint_pos = np.asarray(motion["joint_pos"], float)
    joint_names = list(motion["joint_names"])
    root_pos = np.asarray(motion["root_pos"], float)
    root_quat = np.asarray(motion["root_quat_wxyz"], float)
    phases = list(motion["phases"])
    params = motion["params"]
    n_total = len(times)
    stride = max(1, int(round(author_walk.HZ / FPS)))
    indices = list(range(0, n_total, stride))

    # camera azimuth follows the body yaw with light smoothing, so the duck is
    # always shown from the same 3/4 side no matter which way it is travelling.
    display_yaws = [yaw_deg_wxyz(q) for q in root_quat]
    yaws = unwrap_degrees([math.radians(v) for v in display_yaws])
    azimuths: list[float] = []
    current = None
    for yaw in yaws:
        target = CAM_BASE_AZIMUTH_DEG + yaw
        if current is None:
            current = target
        else:
            diff = (target - current + 180.0) % 360.0 - 180.0
            current += diff * CAM_AZIMUTH_SMOOTHING
        azimuths.append(current)

    # minimise the top-down map: requested path polyline + root trail
    try:
        path_xy = author_result.path.sample_points(240)
    except Exception:
        path_xy = np.asarray(root_pos)[:, :2]
    minimap = Minimap(path_xy, root_pos[:, :2], font=load_font())

    font = load_font()
    follow = FollowRenderer(asset_xml)

    raw_path = out_dir / ".preview_raw.mp4"
    final_path = out_dir / "preview.mp4"
    raw_path.unlink(missing_ok=True)
    writer = None
    try:
        import imageio.v2 as imageio

        writer = imageio.get_writer(
            str(raw_path), fps=FPS, codec="libx264", pixelformat="yuv420p",
            quality=None,
        )
        for out_idx, k in enumerate(indices):
            pane = follow.render_frame(
                root_pos[k], root_quat[k], joint_pos[k], joint_names,
                (root_pos[k][0], root_pos[k][1]), azimuths[k],
            )
            pane_img = Image.fromarray(pane)
            trail = root_pos[: k + 1: stride, :2] if k else root_pos[:1, :2]
            step_label = f"phase {phases[k]}"
            map_img = minimap.render(path_xy, trail, display_yaws[k], step_label)

            frame = Image.new("RGB", (FRAME_W, FRAME_H), COL_BG)
            frame.paste(pane_img, (0, HEADER_H))
            frame.paste(map_img, (FOLLOW_W, HEADER_H))
            draw = ImageDraw.Draw(frame)
            draw.rectangle([0, 0, FRAME_W, HEADER_H], fill=COL_BG)
            draw.rectangle([0, FRAME_H - FOOTER_H, FRAME_W, FRAME_H], fill=COL_BG)
            degraded = " · DEGRADED" if author_result.degraded else ""
            if params.get("pattern") == "hover":
                foot = "left" if params.get("hover_foot") == "left" else "right"
                shape = (f"  ·  {foot} sole lift "
                         f"{float(params.get('lift_height_m', 0.05)) * 1000:.0f} mm"
                         f"  ·  hold {float(params.get('hold_s', 2.5)):g} s")
            elif params.get("pattern") == "composite":
                segments = params.get("segments") or []
                turns = sum(1 for seg in segments if seg.get("kind") == "turn")
                shape = (f"  ·  {len(segments)} segments ({turns} turns)"
                         f"  ·  path {author_result.path.total_length:.2f} m")
            else:
                shape = (f"  ·  radius {params.get('radius_m', 0.09):.2f} m"
                         f"  ·  laps {float(params.get('laps', 1.0)):g}")
            title = (f"Microduck preview  ·  {params['pattern']} {params['direction']}"
                     f"  ·  step {params['step_length_m'] * 1000:.0f} mm"
                     f"{shape}  ·  {params['speed']}{degraded}")
            draw.text((10, 8), title, fill=COL_TEXT, font=font)
            counter = f"frame {out_idx + 1}/{len(indices)}"
            draw.text((FRAME_W - font.getlength(counter) - 10, 8), counter,
                      fill=COL_DIM, font=font)
            yaw_now = display_yaws[k]
            footer = (f"t={times[k]:5.2f}s   root=({root_pos[k][0]:+.3f},{root_pos[k][1]:+.3f}) m"
                      f"   yaw={yaw_now:+6.1f} deg   phase={phases[k]}")
            draw.text((10, FRAME_H - FOOTER_H + 7), footer, fill=COL_WARN, font=font)
            if author_result.degraded:
                note = (f"degraded: {params['pattern']} -> "
                        f"{author_result.effective_pattern}")
                draw.text((FRAME_W - font.getlength(note) - 10, FRAME_H - FOOTER_H + 7),
                          note, fill=(255, 120, 120), font=font)
            writer.append_data(np.asarray(frame))
        writer.close()
        writer = None
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
        follow.close()

    if not raw_path.is_file() or raw_path.stat().st_size < 10_000:
        raise RuntimeError("渲染没有产出有效视频（编码器失败）")
    vid_info = finalize_video(raw_path, final_path)
    prost = probe_video(final_path)
    render_s = time.time() - t_start
    return {
        "frames": len(indices),
        "fps": FPS,
        "duration_s": round(len(indices) / FPS, 3),
        "stride": stride,
        "width": FRAME_W,
        "height": FRAME_H,
        "render_seconds": round(render_s, 2),
        "bytes": final_path.stat().st_size,
        "codec_info": vid_info,
        "probe": prost,
    }


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def build_metrics(params: dict, author_result, render_info: dict,
                  author_seconds: float, total_seconds: float, warnings: list) -> dict:
    geometry = author_result.geometry
    return {
        "schema_version": 1,
        "engine": "real",
        "params": params,
        "effective_params": author_result.effective_params,
        "frames": render_info["frames"],
        "fps": render_info["fps"],
        "duration_s": render_info["duration_s"],
        "motion_duration_s": round(float(author_result.motion["duration_s"]), 3),
        "geometry": {
            "ok": bool(geometry["ok"]),
            "degraded": bool(author_result.degraded),
            "effective_pattern": author_result.effective_pattern,
            "degrade_reason": author_result.degrade_reason,
            "hard_error_count": int(geometry["hard_error_count"]),
            "checks": dict(geometry["checks"]),
        },
        "warnings": list(warnings),
        "created_at": iso_now(),
        "render": {
            "video": "preview.mp4",
            "width": render_info["width"],
            "height": render_info["height"],
            "stride": render_info["stride"],
            "bytes": render_info["bytes"],
            "codec": render_info["codec_info"],
            "probe": render_info["probe"],
            "render_seconds": render_info["render_seconds"],
        },
        "pipeline": {
            "authoring_seconds": round(author_seconds, 2),
            "total_seconds": round(total_seconds, 2),
            "motion_file": "motion.json",
        },
        "authoring": {
            "step_length_m": author_result.motion["authoring"]["step_length_m"],
            "step_length_requested_m": author_result.motion["authoring"]["step_length_requested_m"],
            "step_duration_s": author_result.motion["authoring"]["step_duration_s"],
            "swing_height_m": author_result.motion["authoring"]["swing_height_m"],
            "n_steps": author_result.motion["authoring"]["n_steps"],
            "travel_m": author_result.motion["authoring"]["travel_m"],
            "laps_effective": author_result.motion["authoring"]["laps_effective"],
            "trimmed_for_time_budget": author_result.motion["authoring"]["trimmed_for_time_budget"],
            "max_ik_foot_error_mm": author_result.motion["authoring"]["max_ik_foot_error_mm"],
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a Microduck motion preview")
    parser.add_argument("--params-json", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    # never leave stale success artifacts from an earlier run around
    for stale in ("preview.mp4", "metrics.json", "error.log"):
        (out_dir / stale).unlink(missing_ok=True)
    t0 = time.time()
    author_seconds = 0.0
    try:
        import author_walk

        if not args.params_json.is_file():
            raise author_walk.AuthorError(f"找不到参数文件: {args.params_json}")
        try:
            params_raw = json.loads(args.params_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise author_walk.AuthorError(f"参数文件不是合法 JSON: {exc}") from None

        t_author = time.time()
        result = author_walk.author_motion(params_raw)
        author_seconds = time.time() - t_author
        if args.verbose:
            print(f"[preview] authored {len(result.motion['times'])} frames in "
                  f"{author_seconds:.1f}s, degraded={result.degraded}", flush=True)

        # evidence artifacts for debugging; the Host only needs preview.mp4+metrics.json
        write_json(out_dir / "motion.json", result.motion)
        write_json(out_dir / "authoring_report.json", author_walk.authoring_report(
            result, {"run_preview_authoring_s": round(author_seconds, 2)}))

        t_render = time.time()
        render_info = render_preview(result.motion, result, out_dir, verbose=args.verbose)
        if args.verbose:
            print(f"[preview] rendered {render_info['frames']} frames in "
                  f"{time.time() - t_render:.1f}s", flush=True)

        total_seconds = time.time() - t0
        warnings = list(result.warnings)
        metrics = build_metrics(result.params, result, render_info,
                                author_seconds, total_seconds, warnings)
        write_json(out_dir / "metrics.json", metrics)
        print(json.dumps({
            "ok": True,
            "video": str(out_dir / "preview.mp4"),
            "frames": metrics["frames"],
            "duration_s": metrics["duration_s"],
            "degraded": metrics["geometry"]["degraded"],
            "geometry_ok": metrics["geometry"]["ok"],
            "seconds": metrics["pipeline"]["total_seconds"],
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - one human-readable line on stderr
        try:
            (out_dir / "error.log").write_text(traceback.format_exc(), encoding="utf-8")
        except Exception:
            pass
        message = str(exc).strip().replace("\n", " ") or exc.__class__.__name__
        print(f"ERROR: {message}", file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
