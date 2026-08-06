# Pi Auto Approval

A [Pi](https://github.com/badlogic/pi-mono) extension that resolves Tool Calls with explicit Rules and sends everything else to an isolated Reviewer.

```text
Tool Call
  → Project Rules
  → Global Rules
  → minimal built-in defaults
  → fresh tool-less Reviewer
       → allow | ask | deny
```

A Rule combines a tool/input matcher, an action (`allow`, `ask`, or `deny`), and a Project or Global scope.

## Install

Pi packages execute with full system access. Review this repository before installing it.

```sh
pi install git:github.com/mcthesw/pi-auto-approval
```

Restart Pi, run `/auto-approval`, and choose an authenticated Reviewer model. No npm package has been released yet.

## Behavior

The built-in defaults allow ordinary project-local work:

- `read`, `grep`, `find`, and `ls`, including `.env` files;
- `write` and `edit`, except `.git`, `.pi`, `.agents`, and `AGENTS.md` control paths.

Project-external paths, Bash, control paths, and other tools go to the Reviewer. Several review-eligible calls from one agent turn share one Review Batch while retaining independent decisions. This extension is an authorization layer, not an OS sandbox.

Project Rules take precedence over Global Rules. Within one scope, all matches are considered and the stricter action wins: `deny > ask > allow`.

Matchers support:

- all calls for one tool;
- exact input;
- exact top-level fields;
- Bash token prefixes, displayed as `Bash(cargo fmt *)`;
- file `pathGlob` values.

Compound Bash calls are resolved segment by segment. Unresolved or conservatively unparsable commands go to the Reviewer.

## Interface

`/auto-approval` contains:

- **Rules** — create, edit, or delete Project and Global Rules;
- **Suggestions** — review Rules proposed from recent approval friction;
- **Reviewer** — choose the explicit model and thinking level;
- **Usage display** — choose Detailed token usage, Brief estimated cost, or Off for each Reviewer/Advisor run.

A Tool Call requiring confirmation offers:

- **Allow once**;
- **Allow and create Rule**;
- **Deny**, with optional feedback for the Main Agent.

Selecting `Allow and create Rule` previews up to three proposed Rules inline. Press Enter to allow the Tool Call and save the visible Rules, or `E` to review and edit them first. More than three proposed Rules always open the Review Rules list. All proposed Rules start selected; Suggestions start unselected.

```text
↑/↓  move
Space select
E     view or edit
Enter save
Esc   back
```

Rule editing uses one screen for action, scope, match type, constraints, and advanced JSON. Use `←/→` to change discrete fields quickly. Tool Call approval provides `V` to inspect the full call before deciding; Escape blocks the pending call.

## Storage and security

Configuration is stored outside repositories:

```text
~/.pi/agent/auto-approval.json
```

It is strictly validated, inter-process locked, and atomically written. Invalid configuration never grants permission: interactive sessions ask; non-interactive sessions deny. Version 1 configuration is migrated automatically when read and only version 2 is written.

Every Automated Review uses a fresh in-memory Pi session with no tools, extensions, skills, or persistent history. The real Tool Call, cwd, and bounded conversation context are supplied only as untrusted evidence. Its reported token usage and estimated cost can be shown in the result notification; this usage is not persisted and is not added to Pi's main session totals.

The Rule Advisor runs only when **Suggestions** is opened. Its one-run usage can be shown in the Suggestions subtitle or result notification. It reads at most 50 lossy Friction Records from the last seven days; it stores no Tool Results or conversation transcript.

See [`docs/security.md`](docs/security.md) for the trust boundary and [`CONTEXT.md`](CONTEXT.md) for domain terminology.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm pack --dry-run
```

The manual adversarial Reviewer corpus can be run with `pnpm eval:reviewer`; deterministic CI runs typecheck and unit tests only.

## Provenance

This repository was extracted with history from [`Firstp1ck/pi-coding-agent-forge/pi-extension-safety-guard`](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-extension-safety-guard). It retains the original MIT license and copyright notice.
