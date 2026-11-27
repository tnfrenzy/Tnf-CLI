<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-white.png">
  <img src="docs/assets/logo-black.png" alt="TNF" width="132">
</picture>

# TNF CLI

**Give one command in Vietnamese or English. A team of Claude Code agents works on your repo, and you watch every role on a single screen.**

English | [Tiếng Việt](README.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#install)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5_22.5-339933.svg)](#run-from-source)
[![Version](https://img.shields.io/badge/version-0.1.6-informational.svg)](package.json)
[![Sponsor](https://img.shields.io/badge/♥_sponsor-GitHub_Sponsors-ea4aaa.svg)](https://github.com/sponsors/tnfrenzy)

</div>

---

A **local Windows web app** that drives the official [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude -p`) with **your claude.ai subscription quota** (no API fees). Supports isolated multi-account profiles via `CLAUDE_CONFIG_DIR`, automatic failover on quota limits, and writes code in **separate git worktrees** so your main repo stays clean.

> The user interface is in Vietnamese by default (English is available in the UI). Some documents under `docs/` are in Vietnamese.

## Highlights

| | |
|---|---|
| **Multi-account Claude Code manager** | Isolated profiles via `CLAUDE_CONFIG_DIR`, persistent quota cooldowns with automatic failover between your Claude accounts, and per-role model assignment. |
| **One command, a whole team** | Type a request; the controller assigns analyst, planner, critic, implementer, qa and debug roles (with optional per-role CLI routing) and tracks every step. |
| **Safe on real repos** | Every coding run lives in a worktree on branch `tnf/<run-id>`. Agents may commit but are **blocked from push**, `rm -rf` and `reset --hard`. |
| **Evidence after every run** | Diff, test results, the qa verdict, commit milestones, line comments and a "Continue from here" button. |
| **Idea → task queue** | An idea is clarified, split into small commands with dependencies, reviewed, then run in sequence or in parallel. |
| **Auto-resume after quota limits** | When the 5-hour limit hits, the app schedules a continuation in the same session after the quota refreshes. |
| **See what agents are doing** | A city scene (with active floor glow) and an isometric 2.5D office with lifelike per-character rhythms; a working role gets a glow, its desk screen lights up, and devices in the Gym and the 3D workshop glow. |
| **Works from your phone** | The UI adapts to 375 px, supports file attachments and downloads, through an authenticated tunnel (Tailscale). |
| **Code-driven video studio (experimental)** | Claude writes the code of an animated page using the project's motion library, the app renders each frame in headless Edge/Chrome and assembles an MP4 with ffmpeg; a 3D cabin turntable from the 3D workshop can be used as a scene. |
| **Role library with history and quality checks** | Version history and restore for roles and skills, regression cases per role (run with a read-only `claude -p`), and a per-role effectiveness table across runs. |
| **Self-cleaning queue that resolves conflicts** | A command whose dependency branches conflict on merge gets the `debug` role to resolve them and carry on; Autopilot can delete merged commands after N days (a summary is archived first). |
| **Per-environment worktree setup** | Copies gitignored files (such as `.env`) and runs a time-limited setup command before the agent starts. |
| **External tools** | MCP connections, per-environment permissions, a 3D modelling workshop (CadQuery + Blender) and screenshot previews of your UI. |
| **Honest cost display** | Tokens and cost are **estimates** and are always labelled as such. |

## What's new in 0.1.6

- **Code-driven video studio** replaces the old AI video studio (removed), together with a 3D cabin turntable step from the 3D workshop.
- **2.5D office:** effects that show which agent is working, lit desk screens, device glow in the Gym and the 3D workshop, walkways between towers.
- **Role library:** version history and restore, per-role regression cases, a role effectiveness table.
- **Queue:** automatic conflict resolution when merging dependency branches, explicit failure reasons, orphaned runs closed at startup, per-environment worktree setup.
- **Autopilot:** optional deletion of merged commands after N days and of their git branches under safety conditions (off by default).
- **History:** new Video building and Skill training tabs; the "Runs" popup loads only the 50 most recent runs.
- **Speed:** popups open faster (cost-query indexes, prefetching, a loading state).
- **Fix:** the "Ideas" role table in Settings now applies to the idea-splitting agents.

## Diagrams

### System overview

```mermaid
flowchart LR
  U["User<br/>browser or phone"] -->|"HTTP and WebSocket<br/>token + Origin check"| S["Local server<br/>127.0.0.1:4800"]
  subgraph APP["TNF CLI"]
    S --> RM["RunManager<br/>run lifecycle"]
    RM --> Q["Command queue<br/>ideas to tasks"]
    RM --> DB[("SQLite<br/>runs, events, artifacts")]
    RM --> GIT["Git worktree<br/>branch tnf/run-id"]
    S --> UI["Single-screen UI<br/>city scene and office"]
  end
  RM -->|"spawn without a shell<br/>stream-json"| CLI["Claude Code CLI<br/>claude -p"]
  CLI --> AG["Subagents<br/>analyst, planner, critic,<br/>implementer, qa, debug"]
  AG -->|"edit code, run tests, commit"| GIT
```

### Life of a coding run

```mermaid
flowchart LR
  A["analyst<br/>analysis"] --> P["planner<br/>plan and tasks"]
  P --> C["critic<br/>review"]
  C -->|"needs changes"| P
  C -->|"approved"| I["implementer<br/>up to 2 tasks per call"]
  I --> QA["qa<br/>tests, typecheck, build"]
  QA -->|"PASS"| OK["Commit on branch tnf<br/>diff, tests, verdict"]
  QA -->|"FAIL"| D["debug"]
  D --> QA
```

### From idea to merged code

```mermaid
flowchart TD
  IDEA["Idea in Vietnamese or English"] --> IV["idea-interviewer<br/>up to 5 questions"]
  IV --> SP["idea-splitter<br/>small commands with dependencies"]
  SP --> CR["idea-critic<br/>gaps and file conflicts"]
  CR -->|"re-split once"| SP
  CR --> AP["Approve commands"]
  AP --> RUN["Run all or run in parallel<br/>one worktree per command"]
  RUN -->|"quota limit"| WAIT["Scheduled auto-resume<br/>after the quota refreshes"]
  WAIT --> RUN
  RUN --> CM["Committed"]
  CM --> MG["Merge branch into main"]
```

## Install

### With Setup.exe (recommended, no Node needed)

1. Download `TNF-CLI-Setup-<version>.exe` from **Releases** and run it. The installer needs **no admin rights**, installs to `%LOCALAPPDATA%\TNF\Controller` and adds a system tray icon.
2. Your machine needs **Claude Code CLI signed in** with a claude.ai account (`claude auth status`) and **Git for Windows** in PATH.
3. Start **TNF CLI** from the Start Menu. To try it without spending quota, use the **demo mode** shortcut.

Installing over a newer build keeps your `data\`, `workspace\` and `controller.json`.

### Run from source

Requirements: Windows, Node.js ≥ 22.5, Git for Windows, Claude Code CLI signed in with a claude.ai subscription (no `ANTHROPIC_API_KEY`).

```powershell
git clone https://github.com/tnfrenzy/tnf-cli.git
cd tnf-cli
npm install
.\scripts\start.ps1            # real run
.\scripts\start.ps1 -Demo      # fake CLI replaying fixtures, no tokens spent
```

The server prints an address like `http://127.0.0.1:4800/#token=...`. Open exactly that address (the token is shown only once).

### Build the installer

```powershell
npm run package      # build\app\
npm run installer    # build\TNF-CLI-Setup-<version>.exe (needs Inno Setup 6)
```

## Video studio

> **Experimental:** this is the 5th tower in the city scene. The earlier timeline-style AI video studio has been removed and replaced by this code-driven one; features are missing and may change.

The **Video** tower in the city scene. You describe the video you want; the `video-coder` role (Claude) writes a one-page animation in code using the project's motion library and style templates, the app renders a draft, captures a frame sheet for self-checking, then renders the final video.

- **How it renders:** the page written by Claude runs in headless Edge/Chrome; the renderer seeks frame by frame, captures each frame and assembles an MP4 with ffmpeg.
- **3D cabin turntable:** the 3D workshop renders a turntable shot of a cabin model and the video studio copies it into the project as a scene.
- **Safety:** the agent can only read and write inside the video project folder (Read, Grep, Glob, Write, Edit); no Bash, no network. The page Claude writes has its network blocked in the renderer and can only read files inside the project folder.
- **Cost:** a 20-second 1080x1920 portrait test video cost about 0.51 USD (estimated) and a few minutes to render on the machine tested; real numbers depend on your machine and the length.

Needs [ffmpeg](https://ffmpeg.org/) (found on PATH, or set its path in the Video studio settings) and Edge or Chrome. The motion library lives in `config/codevideo/`; see `config/codevideo/MOTION.md`.

## Command line

```powershell
npm run tnf -- status                               # login and billing guard
npm run tnf -- accounts list                        # list Claude Code CLI accounts
npm run tnf -- accounts add "Work"                  # add an isolated Claude account
npm run tnf -- run "Add a tnf version command" --project controller
npm run tnf -- projects add controller --repo D:\code\repo --base main
npm run tnf -- list                                 # run history
npm run test:fast                                   # fast test suite (accounts, stream, i18n, release)
npm test                                            # full test suite, never calls real CLIs
```

## Safety principles

- The server listens on `127.0.0.1` only; every API call and WebSocket needs the token and passes an `Origin`/`Host` check.
- Subscription mode: `ANTHROPIC_API_KEY` is stripped, and `--bare` or `--dangerously-skip-permissions` are never used.
- `claude` is spawned without a shell; the app never edits `~/.claude/settings.json` or installs global hooks.
- Content fetched from the web is treated as untrusted data; agents do not follow instructions found in it.
- Per-environment permissions are a **guard rail for cooperative agents, not a security sandbox**.

## Documentation

| Document | Contents |
|---|---|
| [Agent Guide (AGENTS.md)](AGENTS.md) | Hard rules, test commands and codebase map for new agent sessions |
| [Handover (HANDOVER.md)](docs/HANDOVER.md) (Vietnamese) | Current status and open items |
| [Detailed guide](docs/GUIDE.md) (Vietnamese) | Install, configuration, phone access, role library, queue, Blender |
| [Specification](docs/CONTEXT-SPEC-v1.md) (Vietnamese) | The effective system specification |
| [Queue and ideas](docs/PLANNER-QUEUE.md) (Vietnamese) | How ideas are split into tasks |
| [Quota auto-resume](docs/QUOTA-AUTO-RESUME.md) (Vietnamese) | Scheduling and restore design |
| [3D workshop](docs/DESIGN-3D.md) (Vietnamese) | 3D modelling agents and Blender rendering |
| [Role evaluation](docs/ROLE-EVAL.md) (Vietnamese) | Regression cases per role and how scores are stored |
| [Role effectiveness](docs/ROLE-STATS.md) (Vietnamese) | The per-role effectiveness table and its hints |
| [Worktree setup](docs/WORKTREE-SETUP.md) (Vietnamese) | Copying gitignored files and running a setup command |
| [Video studio](#video-studio) | How code-driven video making works and its current limits |

## Sponsor

This project is maintained by one person. If it helps your work, you can support it through **[GitHub Sponsors](https://github.com/sponsors/tnfrenzy)**. Thank you.

## License

Apache-2.0, see [LICENSE](LICENSE) and `NOTICE`. Copyright 2026 tnfrenzy. Third-party libraries keep their own licenses.
