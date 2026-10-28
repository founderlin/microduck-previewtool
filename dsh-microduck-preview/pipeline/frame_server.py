#!/usr/bin/env python3
"""Resident MuJoCo frame server for the DSH interactive Microduck viewer.

WHY THIS EXISTS
---------------
The plugin's viewer asks for one JPEG per user interaction ("play / drag the
camera").  Rendering a fresh clip is far too slow for that, but keeping ONE
MuJoCo model + renderer warm makes a frame a ~10-30 ms operation.  This module
is that resident worker: the Host starts one process per finished task
directory, talks to it over stdin/stdout JSON lines, and serves the returned
`image/jpeg` files.

PROTOCOL (fixed; the Host depends on it)
----------------------------------------
Start:
    <python> pipeline/frame_server.py --task-dir <dir with motion.json> \
                                      [--asset-root <microduck-marseille>]

stdout carries ONLY protocol JSON lines (one JSON object per line, flushed).
All logs go to stderr.  The first line is always:

    {"ready": true, "duration_s": 14.82, "fps": 50, "frames": 742,
     "joint_names": [...], "load_ms": 214}

(or {"ready": false, "error": "..."} + exit 2 on startup failure).

After that, each stdin line is a request object:

    {"id": 7, "t": 1.23, "az": 130, "el": -18, "dist": 0.5,
     "follow": true, "lookat": [x, y], "w": 900, "h": 600,
     "shadows": true, "quality": 85}

and each request gets exactly one stdout line:

    {"id": 7, "ok": true,  "file": "<task-dir>/.frames/7.jpg",
     "bytes": 26000, "ms": 13}
    {"id": 7, "ok": false, "error": "..."}          # process stays alive

`t` is seconds and maps to the nearest 50 Hz authored frame; every other field
is optional with the defaults above.  The Host unlinks the JPEG after reading
it; this server only creates `<task-dir>/.frames/`.

stdin EOF / SIGTERM / SIGINT => clean exit (renderers closed).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import signal
import sys
import time
import traceback
from pathlib import Path

MAX_W, MAX_H = 1280, 800
DEFAULT_W, DEFAULT_H = 900, 600
DEFAULT_AZ, DEFAULT_EL, DEFAULT_DIST = 130.0, -18.0, 0.5
FOLLOW_LOOKAT_Z = 0.075
STATIC_LOOKAT = (0.0, 0.0, 0.05)
MIN_SIZE = 64
DEFAULT_QUALITY = 85
MAX_RENDERER_CACHE = 4

DEFAULT_ASSET_ROOT = Path("/Users/founderlin/Desktop/RL研发/microduck-marseille")
ROBOT_XML_REL = Path("src/mjlab_microduck/robot/microduck/robot_groundcontact.xml")

# Checkerboard ground (matches the recorded-mp4 renderer so the viewer and the
# mp4 look like the same scene).
CHECKER_RGB1 = (0.86, 0.87, 0.88)
CHECKER_RGB2 = (0.30, 0.32, 0.35)
CHECKER_REPEAT = 8
CHECKER_HALF_EXTENT_M = 2.0


def add_checker_floor(spec, mujoco, *, repeat: int = CHECKER_REPEAT,
                      half_extent: float = CHECKER_HALF_EXTENT_M,
                      rgb1=CHECKER_RGB1, rgb2=CHECKER_RGB2):
    """Add a checkerboard ground to an MjSpec scene.

    Two details that are easy to get wrong:
      * the colour texture must occupy the ``mjTEXROLE_RGB`` slot (value 1), not
        slot 0 (that is ``mjTEXROLE_USER`` and is never sampled);
      * a plane geom gives degenerate texture coordinates, so the ground is a
        thin box slab whose top face sits exactly at z = 0.
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


# --------------------------------------------------------------------------- #
# stdio helpers -- stdout is protocol-only
# --------------------------------------------------------------------------- #
def log(message: str) -> None:
    print(f"[frame-server] {message}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def safe_token(value) -> str:
    token = re.sub(r"[^A-Za-z0-9_.-]", "_", str(value))[:80]
    return token or "req"


# --------------------------------------------------------------------------- #
# resident server
# --------------------------------------------------------------------------- #
class FrameServer:
    def __init__(self, task_dir: Path, asset_root: Path):
        import mujoco

        self._mujoco = mujoco
        self.task_dir = task_dir
        self.frames_dir = task_dir / ".frames"
        self.frames_dir.mkdir(parents=True, exist_ok=True)

        t_start = time.perf_counter()
        t_model = time.perf_counter()
        self.model, self.data = self._build_model(asset_root)
        self.motion = self._load_motion()
        log(f"model+scene compiled in {(time.perf_counter() - t_model) * 1000:.0f} ms")

        # per-frame joint qpos addresses resolved once
        self.qadr = [int(self.model.joint(n).qposadr[0]) for n in self.motion["joint_names"]]
        self.root_pos = self.motion["root_pos"]
        self.root_quat = self.motion["root_quat_wxyz"]
        self.joint_pos = self.motion["joint_pos"]
        self.n_motion_frames = len(self.root_pos)
        times = self.motion["times"]
        self.control_hz = float(self.motion.get("control_hz") or 50.0)
        if len(times) > 1:
            self.dt = float(times[1] - times[0])
        else:  # pragma: no cover - degenerate motion
            self.dt = 1.0 / self.control_hz
        self.duration_s = float(times[-1]) if len(times) > 1 else 0.0
        self.joint_names = list(self.motion["joint_names"])

        self.cam = mujoco.MjvCamera()
        self.cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        self.cam.elevation = DEFAULT_EL
        self.cam.distance = DEFAULT_DIST
        self.renderers: dict[tuple[int, int], object] = {}

        # Warm the default renderer (GL context + shadow pipeline) BEFORE the
        # ready line: the very first Renderer construction costs ~0.8 s, and a
        # viewer should never pay that on its first interaction.
        warm_start = time.perf_counter()
        self._warmup()
        self.warmup_ms = int(round((time.perf_counter() - warm_start) * 1000))
        log(f"renderer pre-warmed in {self.warmup_ms} ms")
        self.load_ms = int(round((time.perf_counter() - t_start) * 1000))

    # -- construction ------------------------------------------------------ #
    @staticmethod
    def _build_model(asset_root: Path):
        import mujoco

        xml = Path(asset_root) / ROBOT_XML_REL
        if not xml.is_file():
            raise RuntimeError(f"robot model not found: {xml}")
        spec = mujoco.MjSpec.from_file(str(xml))
        # same scene dressing as the render path: a checkerboard floor and a
        # soft key/fill light rig.
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
        model = spec.compile()
        # one offscreen framebuffer big enough for every request; per-size
        # Renderer objects are cached and never need a bigger framebuffer.
        model.vis.global_.offwidth = MAX_W
        model.vis.global_.offheight = MAX_H
        return model, mujoco.MjData(model)

    def _load_motion(self) -> dict:
        path = self.task_dir / "motion.json"
        if not path.is_file():
            raise RuntimeError(f"motion.json not found: {path}")
        motion = json.loads(path.read_text(encoding="utf-8"))
        for key in ("joint_names", "times", "joint_pos", "root_pos", "root_quat_wxyz"):
            if key not in motion:
                raise RuntimeError(f"motion.json missing required field '{key}'")
        return motion

    # -- rendering --------------------------------------------------------- #
    def _get_renderer(self, width: int, height: int):
        key = (width, height)
        renderer = self.renderers.get(key)
        if renderer is not None:
            return renderer
        if len(self.renderers) >= MAX_RENDERER_CACHE:
            oldest_key = next(iter(self.renderers))
            try:
                self.renderers.pop(oldest_key).close()
            except Exception:  # pragma: no cover - defensive
                pass
        renderer = self._mujoco.Renderer(self.model, height=height, width=width)
        self.renderers[key] = renderer
        return renderer

    def close(self) -> None:
        for renderer in self.renderers.values():
            try:
                renderer.close()
            except Exception:
                pass
        self.renderers.clear()

    def frame_index(self, t: float) -> int:
        index = int(round(t / self.dt)) if self.dt > 0 else 0
        return max(0, min(self.n_motion_frames - 1, index))

    def render(self, request: dict) -> dict:
        from PIL import Image

        started = time.perf_counter()
        req_id = request.get("id")
        t = _clamp_float(request.get("t", 0.0), 0.0, self.duration_s)
        width = _clamp_int(request.get("w", DEFAULT_W), MIN_SIZE, MAX_W)
        height = _clamp_int(request.get("h", DEFAULT_H), MIN_SIZE, MAX_H)
        azimuth = _clamp_float(request.get("az", DEFAULT_AZ), -3600.0, 3600.0)
        elevation = _clamp_float(request.get("el", DEFAULT_EL), -90.0, 90.0)
        distance = _clamp_float(request.get("dist", DEFAULT_DIST), 0.02, 8.0)
        shadows = bool(request.get("shadows", True))
        quality = _clamp_int(request.get("quality", DEFAULT_QUALITY), 30, 95)
        follow = request.get("follow", True)
        follow = bool(follow) if isinstance(follow, bool) else True

        index = self.frame_index(t)
        data = self.data
        data.qpos[:3] = self.root_pos[index]
        data.qpos[3:7] = self.root_quat[index]
        for adr, value in zip(self.qadr, self.joint_pos[index]):
            data.qpos[adr] = value
        data.qvel[:] = 0.0
        self._mujoco.mj_forward(self.model, data)

        if follow:
            lookat = [float(self.root_pos[index][0]), float(self.root_pos[index][1]), FOLLOW_LOOKAT_Z]
        else:
            raw_lookat = request.get("lookat")
            if isinstance(raw_lookat, (list, tuple)) and len(raw_lookat) >= 2:
                lx = _clamp_float(raw_lookat[0], -50.0, 50.0)
                ly = _clamp_float(raw_lookat[1], -50.0, 50.0)
                lz = _clamp_float(raw_lookat[2], 0.0, 2.0) if len(raw_lookat) > 2 else STATIC_LOOKAT[2]
                lookat = [lx, ly, lz]
            else:
                lookat = list(STATIC_LOOKAT)
        self.cam.azimuth = azimuth
        self.cam.elevation = elevation
        self.cam.distance = distance
        self.cam.lookat[:] = lookat

        renderer = self._get_renderer(width, height)
        renderer.update_scene(data, camera=self.cam)
        renderer.scene.flags[self._mujoco.mjtRndFlag.mjRND_SHADOW] = 1 if shadows else 0
        image = renderer.render()

        if not self.frames_dir.is_dir():  # host may clean the task dir
            self.frames_dir.mkdir(parents=True, exist_ok=True)
        out_path = self.frames_dir / f"{safe_token(req_id)}.jpg"
        Image.fromarray(image).save(out_path, format="JPEG", quality=quality, optimize=False)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return {
            "id": req_id,
            "ok": True,
            "file": str(out_path),
            "bytes": out_path.stat().st_size,
            "ms": round(elapsed_ms, 2),
        }

    def _warmup(self) -> None:
        """Render one throw-away frame at the default size to initialise GL."""
        import mujoco

        data = self.data
        data.qpos[:3] = self.root_pos[0]
        data.qpos[3:7] = self.root_quat[0]
        for adr, value in zip(self.qadr, self.joint_pos[0]):
            data.qpos[adr] = value
        data.qvel[:] = 0.0
        mujoco.mj_forward(self.model, data)
        self.cam.azimuth = DEFAULT_AZ
        self.cam.elevation = DEFAULT_EL
        self.cam.distance = DEFAULT_DIST
        self.cam.lookat[:] = [float(self.root_pos[0][0]), float(self.root_pos[0][1]), FOLLOW_LOOKAT_Z]
        renderer = self._get_renderer(DEFAULT_W, DEFAULT_H)
        renderer.update_scene(data, camera=self.cam)
        renderer.render()

    # -- request loop ------------------------------------------------------ #
    def serve(self) -> int:
        emit({
            "ready": True,
            "duration_s": round(self.duration_s, 6),
            "fps": self.control_hz,
            "frames": self.n_motion_frames,
            "joint_names": self.joint_names,
            "load_ms": self.load_ms,
        })
        rss_mb = 0.0
        try:
            import resource
            usage = resource.getrusage(resource.RUSAGE_SELF)
            rss_mb = round(usage.ru_maxrss / 1024.0 / 1024.0, 1)
        except Exception:  # pragma: no cover - non-POSIX
            pass
        log(f"ready: {self.n_motion_frames} frames @ {self.control_hz:g} Hz, "
            f"{self.duration_s:.2f} s, load {self.load_ms} ms, peak RSS {rss_mb} MB")
        while True:
            line = sys.stdin.readline()
            if line == "":
                log("stdin EOF, exiting")
                return 0
            line = line.strip()
            if not line:
                continue
            request = None
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                emit({"id": None, "ok": False, "error": f"invalid json: {exc}"})
                continue
            if not isinstance(request, dict):
                emit({"id": None, "ok": False, "error": "request must be a JSON object"})
                continue
            req_id = request.get("id")
            try:
                reply = self.render(request)
            except Exception as exc:  # noqa: BLE001 - keep the worker alive
                log(f"request {req_id!r} failed: {exc}")
                traceback.print_exc(file=sys.stderr)
                reply = {"id": req_id, "ok": False, "error": str(exc) or exc.__class__.__name__}
            try:
                emit(reply)
            except BrokenPipeError:
                log("stdout closed, exiting")
                return 0


# --------------------------------------------------------------------------- #
# input coercion helpers
# --------------------------------------------------------------------------- #
def _clamp_float(value, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(low if value is None else 0.0)
    if not math.isfinite(number):
        return float(low)
    return float(min(max(number, low), high))


def _clamp_int(value, low: int, high: int) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return int(low)
    return int(min(max(number, low), high))


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def _raise_exit(signum, frame):  # pragma: no cover - signal path
    raise SystemExit(0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Resident MuJoCo frame server for the Microduck viewer")
    parser.add_argument("--task-dir", required=True, type=Path,
                        help="task directory containing motion.json")
    parser.add_argument("--asset-root", type=Path,
                        default=Path(os.environ.get("MICRODUCK_ASSET_ROOT") or DEFAULT_ASSET_ROOT),
                        help="microduck-marseille checkout root")
    args = parser.parse_args(argv)

    signal.signal(signal.SIGTERM, _raise_exit)
    signal.signal(signal.SIGINT, _raise_exit)

    task_dir = args.task_dir
    if not task_dir.is_absolute():
        task_dir = (Path.cwd() / task_dir)
    server = None
    try:
        server = FrameServer(task_dir.resolve(), args.asset_root.expanduser())
        return server.serve()
    except SystemExit:
        return 0
    except Exception as exc:  # noqa: BLE001 - startup failure must be reported on stdout
        log(f"startup failed: {exc}")
        traceback.print_exc(file=sys.stderr)
        try:
            emit({"ready": False, "error": str(exc) or exc.__class__.__name__})
        except Exception:
            pass
        return 2
    finally:
        if server is not None:
            server.close()


if __name__ == "__main__":
    raise SystemExit(main())
