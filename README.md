# Pi Auto Approval

A [Pi](https://github.com/badlogic/pi-mono) extension that resolves known Tool Calls with explicit Rules and sends everything else to an isolated Reviewer.

```text
Tool Call
  -> Project Rules
  -> Global Rules
  -> minimal built-in defaults
  -> fresh tool-less Reviewer
       -> allow | ask | deny
```

A Rule is always the same thing: a tool and structured parameter matcher, an action (`allow`, `ask`, or `deny`), and a scope (current project or global).

## Install

Pi packages execute with full system access. Review this repository before installing it.

```sh
pi install git:github.com/mcthesw/pi-extension-auto-approval
```

Restart Pi, then run `/auto-approval` to select an authenticated Reviewer model. The settings menu has only three entries:

- **Rules** — current Project and Global Rules
- **Suggestions** — Rule Advisor proposals from recent approval friction
- **Reviewer** — the explicit model and thinking level

No npm package has been released yet.

## Defaults and Rules

The minimal built-in defaults are quiet for ordinary coding work:

- Project-local `read`, `grep`, `find`, and `ls` are allowed, including `.env` files.
- Project-local `write` and `edit` are allowed except for `.git`, `.pi`, `.agents`, and `AGENTS.md` control paths.
- Project-external paths, Bash, control paths, and other tools go to the Reviewer.

The Reviewer may allow a one-off project-external operation when the user explicitly requested it. When one agent turn emits several calls that all need review, Pi Auto Approval sends them in one isolated Review Batch and keeps an independent Allow, Ask, or Deny result for every call. Rules and user confirmations remain per-call. Pi Auto Approval is an authorization layer, not an OS sandbox.

Rules run before defaults. Project Rules take precedence over Global Rules. Within one scope, all matching Rules are considered and the more restrictive action wins: `deny > ask > allow`. Identical matchers are unique within a scope, so editing the action updates that Rule instead of creating a conflict.

Bash Rules use conservative argv-prefix semantics but familiar display text:

```text
Allow · Global  Bash(cargo fmt *)
Allow · Global  context7:query-docs
Ask   · Project Read(.env)
```

For compound Bash calls, each visible command segment must be resolved; an unresolved or unparsable segment goes to the Reviewer. A whole-call Exact Rule remains authoritative.

## User confirmation

When a call needs confirmation, choose one of:

- **Allow once**
- **Always allow with Rule**
- **Deny** — optionally include feedback for the Main Agent

The Reviewer may propose a matcher and scope. The proposal is editable and inactive until you save it. If a proposal is invalid or unavailable, Pi Auto Approval falls back to a Project Exact Rule. New rules for external tools automatically bind reliable Pi source identity when available; the source is shown only in Rule details.

## Configuration

Configuration lives outside the repository:

```text
~/.pi/agent/auto-approval.json
```

It is strictly validated, protected by an inter-process lock, and atomically written. Version 1 files are read as version 2 automatically: old Approval and Policy Rules become Rules, `auto_review` entries are removed, and duplicate matchers retain the most restrictive action. The next successful write uses version 2.

```json
{
  "version": 2,
  "reviewer": {
    "provider": "openai",
    "modelId": "gpt-5.4-mini",
    "thinkingLevel": "low"
  },
  "globalRules": [
    {
      "id": "context7-docs",
      "action": "allow",
      "matcher": {
        "tool": "context7_query-docs",
        "source": { "source": "mcp", "path": "context7" },
        "input": { "kind": "any" }
      }
    }
  ],
  "projects": {
    "/canonical/project/root": {
      "rules": [
        {
          "id": "format",
          "action": "allow",
          "matcher": {
            "tool": "bash",
            "input": {
              "kind": "fields",
              "fields": {
                "command": { "kind": "tokenPrefix", "tokens": ["cargo", "fmt"] }
              }
            }
          }
        }
      ]
    }
  }
}
```

Matchers support whole-tool, whole-input Exact, top-level field Exact, Bash token prefix, and file `pathGlob`. Project path globs are project-relative; Global path globs must be absolute or home-anchored. No regex, JSONPath, nested conditions, or Bash middle wildcards are supported. Invalid configuration never grants permission: interactive sessions ask, while non-interactive sessions deny.

## Reviewer and Advisor

Every review uses a fresh in-memory Pi session with no tools, extensions, skills, prompts, themes, or persistent history. Its operational cwd is intentionally separate from the project cwd; the real cwd, Tool Call, limited metadata, and bounded conversation context are untrusted evidence.

The Rule Advisor is manually invoked from **Suggestions**. It reads at most 50 lossy Friction Records from the last seven days and proposes at most 10 ordinary Rules. Suggestions may use any valid action, scope, and matcher, but all start unselected and only save after explicit user confirmation. Friction History stores no Tool Results or conversation transcript.

## Reviewer eval

The fixed adversarial corpus is a manual quality check, not a CI dependency:

```sh
pnpm eval:reviewer
```

It uses the Reviewer configured in `~/.pi/agent/auto-approval.json`, prints each expected and actual decision, and exits non-zero on a mismatch. CI runs only deterministic typecheck and unit tests.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm pack --dry-run
```

See [`docs/security.md`](docs/security.md) for the trust boundary, [`CONTEXT.md`](CONTEXT.md) for the glossary, and [`docs/adr`](docs/adr) for historical decisions.

## Provenance

This repository was extracted with history from [`Firstp1ck/pi-coding-agent-forge/pi-extension-safety-guard`](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-extension-safety-guard). It retains the original MIT license and copyright notice.
