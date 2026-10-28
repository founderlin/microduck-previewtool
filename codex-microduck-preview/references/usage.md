# Runtime and usage

Requires Node.js 22.19 or newer, an executable Python with `mujoco`, `numpy`, `scipy`, `Pillow`, `imageio`, and `imageio-ffmpeg`, and the Microduck model/assets checkout. Run `doctor` to inspect the actual dependencies before rendering.

## Directory and installation

Keep the two folders beside one another:

```text
microduck-previewtool/
  dsh-microduck-preview/
  codex-microduck-preview/
  .runtime/codex/       # created at runtime, excluded from source control
```

From the skill directory:

```sh
node scripts/install.mjs
node scripts/install.mjs --check
```

The installer links the skill into `${CODEX_HOME:-~/.codex}/skills/codex-microduck-preview`; it refuses to overwrite another skill or directory. The CLI resolves the real installation path so sibling imports continue to work. Moving the complete project requires recreating the link. The new DSH copy is not automatically activated in DSH: the existing original installation stays in place.

To remove only this installation link, run `node scripts/install.mjs --uninstall`. Stop the local service separately if desired. Neither operation deletes the project or tasks. Codex may need a new chat or reload to discover a newly installed skill.

## Configuration

Environment variables override runtime configuration:

| Variable | Purpose |
| --- | --- |
| `MICRODUCK_CONFIG` | Path to an optional JSON configuration file |
| `MICRODUCK_PYTHON` | Python executable with renderer dependencies |
| `MICRODUCK_ASSET_ROOT` | Root of the Microduck model/assets checkout |
| `MICRODUCK_DATA_DIR` | Task and service directory; default `<project>/.runtime/codex` |
| `MICRODUCK_PORT` | Loopback HTTP port; default `47832` |
| `CODEX_THREAD_ID` | Current conversation identifier when `--session` is omitted |

Default machine paths are the existing Microduck Python and assets paths discovered during development. They can be replaced for another machine. The service listens only on `127.0.0.1`. Changing a running service's settings requires `stop`, then a new command to start it with the new settings. Do not edit global Codex configuration to use this CLI-based skill.

## Commands

These commands can run from any working directory by using an absolute script path. The shell examples assume the skill directory. Replace the sample session with the current conversation ID.

```sh
node scripts/microduck.mjs doctor
node scripts/microduck.mjs templates --session example-chat
node scripts/microduck.mjs preview --session example-chat --params '{"pattern":"figure8","direction":"backward","step_length_m":0.025,"radius_m":0.10}'
node scripts/microduck.mjs status --session example-chat --task TASK_ID
node scripts/microduck.mjs preview --session example-chat --params '{"radius_m":0.12}'
node scripts/microduck.mjs history --session example-chat
node scripts/microduck.mjs viewer --session example-chat
node scripts/microduck.mjs stop
```

For larger JSON, write a task-specific file and use `--params-file /absolute/params.json`. Do not interpolate untrusted JSON into a shell command. `--base-task TASK_ID` inherits a specific task from the same session. `--wait-ms` may be 0–25000; default 0 returns the task immediately. Queued and running tasks should be polled through `status`, not submitted again.

`start` explicitly launches or reuses a detached service, logging to `<dataDir>/server.log`. `serve` runs it in the foreground for diagnostics. `stop` checks service identity and sends a shutdown request, rather than killing a PID that might belong to another process. Restarting turns interrupted tasks into errors and keeps their logs available.

## Viewer, results, and boundaries

Open the returned `viewer_url` in Codex's built-in browser, preferably on the right. The URL scopes history to one session and optionally selects a task. The viewport orbits on drag, zooms on wheel, follows or resets the camera, scrubs time, and plays once to the end. A recorded MP4 fallback remains available for completed tasks that lack interactive motion data. Hidden viewers stop requesting frames and release their worker.

Use the viewer's `导出 MP4` link for browser download, or the task's `video_path` for local file delivery. Video requests support HTTP Range for seeking. Task artifacts remain under `<dataDir>/tasks/<task_id>/`, including parameters, motion, metrics, preview MP4, and logs. Keep exported deliverables in a user-requested location rather than copying runtime internals into unrelated projects.

The web viewer has no dependency on a logged-in DSH page. Its appearance matches the approved concept's right-side preview panel; Codex's own conversation layout remains controlled by Codex. Inline native custom cards are not claimed. `DEMO` content is a sample clip, degradation describes the actual substituted motion, and a geometric pass is not a dynamic stability or real-robot safety result.
