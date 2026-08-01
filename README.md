# Pi Auto Approval

A [Pi](https://github.com/badlogic/pi-mono) extension that approves known Tool Calls deterministically and sends residual calls to an isolated model reviewer.

```text
Tool Call
  -> project Approval Rules
  -> ordered Approval Policy
       -> approve | deny | ask_user | auto_review
       -> fresh tool-less Review Agent
            -> approve | deny | ask_user
```

Explicit user-created Approval Rules are authoritative. Automated Review is used only when no deterministic rule decides the call.

## Install

Pi packages execute with full system access. Review this repository before installing it.

```sh
pi install git:github.com/mcthesw/pi-extension-auto-approval
```

Restart Pi, then run:

```text
/auto-approval
```

Select an authenticated Reviewer model and its thinking level. The extension reminds you once at session startup when the Reviewer is missing or unavailable.

No npm package has been released yet.

## Default policy

The built-in policy applies only to Pi built-in tools. A custom extension that overrides a built-in tool name does not inherit its approval.

- Project-local `read`, `grep`, `find`, and `ls` calls are approved.
- Project-local `write` and `edit` calls are approved except for Control Paths: `.git`, `.pi`, `.agents`, and `AGENTS.md`.
- A conservative Bash classifier approves a small read-only command set only when the command syntax, arguments, executable resolution, Pi shell settings, and relevant environment variables can all be verified. Git and `file` commands are excluded because repository/configuration hooks or options can execute programs or write files.
- Everything else routes to Automated Review.

User Policy Rules run before these built-in defaults. Project Approval Rules run before all Policy Rules.

## User confirmation

When a call needs confirmation, choose one of:

- **Approve once**
- **Always approve** — review and edit the proposed structured matcher before saving it
- **Deny** — optionally add feedback for the Main Agent

Accepted Approval Rules are stored for the current project. A rule proposed by the Review Agent is inert until you explicitly accept it.

## Configuration

Configuration is stored outside repositories:

```text
~/.pi/agent/auto-approval.json
```

It is versioned, strictly validated, written atomically, and protected by an inter-process lock. Projects are keyed by canonical Git root, or canonical working directory outside Git.

```json
{
  "version": 1,
  "reviewer": {
    "provider": "openai",
    "modelId": "gpt-5.4-mini",
    "thinkingLevel": "low"
  },
  "projects": {
    "/canonical/project/root": {
      "policyRules": [
        {
          "id": "review-control-files",
          "route": "ask_user",
          "matcher": {
            "tool": "write",
            "input": {
              "kind": "fields",
              "fields": {
                "path": { "kind": "pathGlob", "pattern": ".github/**" }
              }
            }
          }
        }
      ],
      "approvalRules": [
        {
          "id": "approve-status",
          "matcher": {
            "tool": "bash",
            "input": {
              "kind": "fields",
              "fields": {
                "command": { "kind": "tokenPrefix", "tokens": ["git", "status"] }
              }
            }
          }
        }
      ]
    }
  }
}
```

Available Policy routes are `approve`, `deny`, `ask_user`, and `auto_review`. Matcher capabilities are intentionally limited:

- `exact` matches the complete JSON input.
- `fields` matches named top-level scalar fields.
- `pathGlob` uses project-relative POSIX paths and `minimatch` syntax.
- Bash `tokenPrefix` matches conservatively tokenized command prefixes.

Unknown and custom tools require complete-input `exact` matchers. Use `/auto-approval` to manage Reviewer settings and project rules. Invalid configuration never grants permission: interactive sessions ask, while non-interactive sessions deny.

## Automated Review

Each review creates a fresh in-memory Pi SDK session with:

- no extensions, tools, skills, prompts, themes, or persistent history;
- a fixed reviewer policy;
- the exact Tool Call JSON and bounded recent transcript evidence;
- explicit cwd, project root, and limited tool metadata;
- a strict `approve`, `deny`, or `ask_user` JSON response.

The transcript, tool metadata, and project content are labeled as untrusted evidence. Interactive sessions immediately show each Automated Review decision, tool name, and bounded single-line reason; deterministic approvals remain quiet. Reviewer timeout, malformed output, missing configuration, or runtime failure falls back to User Confirmation when UI is available and denial otherwise. Caller cancellation denies without opening another prompt.

See [`docs/security.md`](docs/security.md) for the trust boundary and known limitations, [`CONTEXT.md`](CONTEXT.md) for project language, and [`docs/adr`](docs/adr) for architectural decisions.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm pack --dry-run
```

## Provenance

This repository was extracted with history from [`Firstp1ck/pi-coding-agent-forge/pi-extension-safety-guard`](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-extension-safety-guard). It retains the original MIT license and copyright notice.
