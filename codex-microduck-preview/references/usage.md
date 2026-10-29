# Runtime and usage

Requires Node.js 22.19 or newer, an executable Python with `mujoco`, `numpy`, `scipy`, `Pillow`, `imageio`, and `imageio-ffmpeg`, and the Microduck model/assets checkout. Run `doctor` to inspect the actual dependencies before rendering.

## Directory and installation

Keep the shared plugin, parent and four child skill folders together:

```text
microduck-previewtool/
  dsh-microduck-preview/
  codex-microduck-preview/
  microduck-preview-runtime/
  microduck-motion-compose/
  microduck-reward-studio/
  microduck-train-pack/
  .runtime/codex/       # created at runtime, excluded from source control
```

From the skill directory:

```sh
node scripts/install.mjs
node scripts/install.mjs --check
```

The installer links the parent and all four supporting skills into `${CODEX_HOME:-~/.codex}/skills/`. Add `--cursor` to target `~/.cursor/skills/`. It refuses to overwrite another skill or directory. The CLI resolves the real installation path so sibling imports continue to work. Moving the complete project requires recreating the link. The new DSH copy is not automatically activated in DSH: the existing original installation stays in place.

To remove this project’s six installation links, run `node scripts/install.mjs --uninstall`; add `--cursor` for Cursor links. Stop the local service separately if desired. Neither operation deletes the project or tasks. Codex may need a new chat or reload to discover a newly installed skill.

## Configuration

Environment variables override runtime configuration:

| Variable | Purpose |
| --- | --- |
| `MICRODUCK_CONFIG` | Path to an optional JSON configuration file |
| `MICRODUCK_PYTHON` | Python executable with renderer dependencies |
| `MICRODUCK_ASSET_ROOT` | Root of the Microduck model/assets checkout |
| `MICRODUCK_DATA_DIR` | Task and service directory; default `<project>/.runtime/codex` |
| `MICRODUCK_PORT` | Loopback HTTP port; default `47832` |
| `CODEX_THREAD_ID` | Current Codex conversation identifier when `--session` is omitted |
| `CURSOR_CHAT_ID` | Cursor conversation identifier when both `--session` and `CODEX_THREAD_ID` are absent |

The default Python points to the local training checkout. Assets are inferred from the selected venv interpreter unless explicitly configured. They can be replaced for another machine. The service listens only on `127.0.0.1`. Changing a running service's settings requires `stop`, then a new command to start it with the new settings. Do not edit global Codex configuration to use this CLI-based skill.

## Commands

These commands can run from any working directory by using an absolute script path. The shell examples assume the skill directory. Replace the sample session with the current conversation ID.

```sh
node scripts/microduck.mjs doctor
node scripts/microduck.mjs templates --session example-chat
node scripts/microduck.mjs preview --session example-chat --params '{"pattern":"figure8","direction":"backward","step_length_m":0.025,"radius_m":0.10}'
node scripts/microduck.mjs status --session example-chat --task TASK_ID
node scripts/microduck.mjs preview --session example-chat --params '{"radius_m":0.12}'
node scripts/microduck.mjs viewer --session example-chat
node scripts/microduck.mjs stop
```

For larger JSON, write a task-specific file and use `--params-file /absolute/params.json`. Do not interpolate untrusted JSON into a shell command. `--base-task TASK_ID` inherits a specific task from the same session. `--wait-ms` may be 0–25000; default 0 returns the task immediately. Queued and running tasks should be polled through `status`, not submitted again.

`start` explicitly launches or reuses a detached service, logging to `<dataDir>/server.log`. `serve` runs it in the foreground for diagnostics. `stop` checks service identity and sends a shutdown request, rather than killing a PID that might belong to another process. Restarting turns interrupted tasks into errors and keeps their logs available.

## Viewer, results, and boundaries

Open the returned `viewer_url` in Codex's built-in browser, preferably on the right. The URL scopes the current action to one session. The playground orbits on drag, zooms on wheel, and supports execute, stop, reset and on-demand video export. Hidden viewers stop requesting frames and release their worker.

Use the viewer's `导出 MP4` link for browser download, or the task's `video_path` for local file delivery. Video requests support HTTP Range for seeking. Task artifacts remain under `<dataDir>/tasks/<task_id>/`, including parameters, motion, metrics, preview MP4, and logs. Keep exported deliverables in a user-requested location rather than copying runtime internals into unrelated projects.

The web viewer has no dependency on a logged-in DSH page. Its appearance matches the approved concept's right-side preview panel; Codex's own conversation layout remains controlled by Codex. Inline native custom cards are not claimed. `DEMO` content is a sample clip, degradation describes the actual substituted motion, and a geometric pass is not a dynamic stability or real-robot safety result.

## Motion workbench

The parent routes to four sibling skills: runtime, motion-compose, reward-studio and train-pack. The installer installs all six links; `--cursor` selects `~/.cursor/skills`. Keep these folders alongside the DSH package. `CURSOR_CHAT_ID` is accepted when `CODEX_THREAD_ID` is absent; otherwise pass the current chat id explicitly.

Assets are inferred from the selected Python venv. Port `47832` is only preferred; occupied ports trigger an ephemeral loopback port. Always use the returned URL. The two hosts serve the same workbench assets from `dsh-microduck-preview/assets`.

```sh
node scripts/microduck.mjs preview --session example-chat --params '{"pattern":"composite","segments":[{"kind":"straight","length_m":0.2},{"kind":"hover","hover_foot":"right","lift_height_m":0.04,"hold_s":2},{"kind":"stand","hold_s":1}]}'
node scripts/microduck.mjs rewards list --session example-chat --task TASK_ID
node scripts/microduck.mjs rewards set --session example-chat --task TASK_ID --id upright --weight 2.5 --params '{"std":0.25}' --phases hover,stand
node scripts/microduck.mjs rewards explain --session example-chat --task TASK_ID --id upright
node scripts/microduck.mjs pack --session example-chat --task TASK_ID
node scripts/microduck.mjs verify --pack /absolute/pack-directory
```

`command.json` is frame-aligned with the motion, including vx/wz, stages and support feet. Composite segments accept straight, turn, hover and stand; sidestep explicitly substitutes a 90° turn followed by straight travel. Timeline editing provides insertion, deletion and reordering. Command curves describe the authored reference, not a sampled training policy.

Reward selections are per task and session, with immutable versions. Function and parameter names resolve against the configured training Python and checkout. Invalid functions stay disabled. Explain clips use actual training functions on labeled kinematic inputs; unavailable sensor or torque terms show training_only. They do not predict the effect of changing a policy's reward weight.

`pack` invokes `scripts/train_microduck_cpu.py` runtime helpers from the training checkout, uses its registered velocity environment and original BAM actuator, and writes a fresh review directory. It never creates a PPO runner. Initial reference pose is written once; subsequent steps apply normal actions with a free root, normal BAM delays and friction. First terminal stops measurement. `physics.json` separates runtime failure, geometry eligibility, and completion of the baseline. Baseline failure is a risk requiring review, not proof that learning is impossible. `verify` detects changed artifacts, robot sources or workbench tools.

Optional JSON settings: `preflightTask` (default `Mjlab-Velocity-Flat-MicroDuck`), `preflightSeeds` (default `[123,2026]`, maximum four), and `taskCriteria`. All unspecified task thresholds remain null. Exported command/reward/criteria files require explicit import by the training workflow. There is no training, approval or deployment command here.
