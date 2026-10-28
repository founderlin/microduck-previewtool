---
name: codex-microduck-preview
description: Generate and tune Microduck walking or pose previews from natural language, inspect real MuJoCo motion in a Codex browser panel, and export videos. Use for Microduck trajectory, gait, or single-foot hover previews; video imitation, policy training, and robot deployment require other workflows.
---

# Microduck Preview

Turn the user's requested Microduck movement into validated parameters, run the local preview pipeline, and show an interactive MuJoCo viewer inside Codex. Use the scripts in this skill directory; the sibling `dsh-microduck-preview/` supplies the shared core and pipeline. Resolve this skill's real directory when it is installed through a symlink.

## Execute and show the result

Use `node <skill-directory>/scripts/microduck.mjs <command>`. Commands return one JSON object. Use the current `CODEX_THREAD_ID`, or explicitly pass `--session <current-chat-id>` consistently across calls. If the environment has no chat ID, choose a fresh unique ID for this chat and retain it for follow-ups; never use a global default or another chat's ID.

1. Run `doctor` on first use, and after dependency failures. If `ok` is false, explain the failed checks and fix only what the user has authorized. Do not switch to demo to hide a missing real dependency.
2. Call `templates --session <id>` to read current supported parameters and this chat's recent tasks. The CLI starts or reuses the local service automatically.
3. Map the requested movement to parameters and call `preview --session <id> --params '<JSON>'`. Default submission is nonblocking. Preserve its task ID and use `status --session <id> --task <task_id>` to wait for completion; do not resubmit while queued or running.
4. Open the returned `viewer_url` with the available `open_in_codex` tool, using target `{type:"browser", url: viewer_url}` and placement `"right"`. For an existing task, retrieve its URL with `viewer --session <id> --task <task_id>`. The viewer shows this chat's task history, parameters, orbit/zoom, time scrubbing, playback, and MP4 export.
5. Report the requested and actual motion, geometric result, warnings, and video location. Keep progress short while rendering. If opening a panel is unavailable, provide the local viewer link and supported video/image output without claiming that an interactive panel was displayed.

## Interpret requests and follow-ups

- “倒退走 8 字，步子小一点”: `{"pattern":"figure8","direction":"backward","step_length_m":0.025,"radius_m":0.10}`.
- “圈再大一点”: inspect this chat's latest task, then submit only an increased `radius_m` within the reported limits. The service inherits omitted parameters from the latest task in this same chat. Use `--base-task <task_id>` when tuning a specific historical task instead.
- A clearly new movement should receive explicit intended values rather than accidentally inheriting an unrelated preceding movement. Accepted patterns include straight, arc, figure eight, composite segments, and single-foot hover; read the live catalogue for exact ranges and optional fields.
- For hover, `hover_foot` names the lifted foot. For composite motion, preserve the user's segment ordering and signed turn directions.
- Do not silently clamp invalid parameters. Surface the returned range and correction, then adjust according to the user's intent.

## Present honestly

The skill opens a real web viewer in Codex's browser side panel. A normal skill cannot itself install a native custom chat card. In the conversation, use the host's supported text, links, and media rendering; never pretend a generated concept image or unsupported card is a working UI.

Frames are rendered from the real MuJoCo model and motion, rather than simulating a duck animation in the browser. Geometry checks and kinematic previews do not establish dynamic balance, learned control quality, or safe physical execution. Display `DEMO` and explain if the configured engine returns a sample clip. Display degradation and the actual effective trajectory; a degraded arc is not a successfully completed requested figure eight. Report errors without fabricating video or success.

Read [usage and configuration](references/usage.md) when changing runtime paths, installing the skill, troubleshooting the service, or exporting artifacts. `stop` ends only this project's verified service; ordinary task completion does not require stopping the viewer while the user is inspecting it.
