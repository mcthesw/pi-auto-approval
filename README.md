# Pi Auto Approval

A [Pi](https://github.com/badlogic/pi-mono) extension that approves known Tool Calls deterministically and sends residual calls to an isolated model reviewer.

```text
Tool Call
  -> project Approval Rules
  -> ordered project Approval Policy
  -> source-bound Global Tool-wide Rules
  -> built-in defaults
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

The standard-tool policy applies by Tool name and input semantics, including standard Pi tools supplied through an SDK host. Pi extensions already execute with the user's process permissions, so provenance labels are not treated as a sandbox boundary.

- Project-local `read`, `grep`, `find`, and `ls` calls are approved.
- Project-local `write` and `edit` calls are approved except for Control Paths: `.git`, `.pi`, `.agents`, and `AGENTS.md`.
- A conservative Bash classifier approves a small read-only command set only when the command syntax, arguments, executable resolution, Pi shell settings, and relevant environment variables can all be verified. Git approval is limited to metadata-only `log`, `rev-parse`, and `branch --show-current` forms; `file`, diff-producing Git operations, and other Git commands remain excluded.
- Everything else routes to Automated Review.

Project Approval Rules run first, followed by ordered project Policy Rules, source-bound Global Tool-wide Rules, and built-in defaults.

## User confirmation

When a call needs confirmation, choose one of:

- **Approve once** — selected by default
- **Always approve** — review and edit the proposed structured matcher before saving it
- **Deny** — optionally add feedback for the Main Agent

Accepted rules default to the current project. For a non-standard Tool with a reliable source identity, Always approve defaults to a source-bound Tool-wide matcher instead of a volatile exact input snapshot. A Tool-wide rule can be explicitly switched to Global Scope with ←/→. A rule proposed by the Review Agent or Rule Advisor is inert until you explicitly accept it.

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
  "globalApprovalRules": [],
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

Unknown and custom tools support complete-input `exact` matchers. Non-standard tools with a current source identity can additionally use an explicit `any` matcher for all inputs; only that Tool Identity may be granted Global Scope. Use `/auto-approval` to manage Reviewer settings and rules. Invalid configuration never grants permission: interactive sessions ask, while non-interactive sessions deny.

## Automated Review

Each review creates a fresh in-memory Pi SDK session with:

- no extensions, tools, skills, prompts, themes, or persistent history;
- a fixed reviewer policy;
- the exact Tool Call JSON and bounded recent transcript evidence;
- explicit cwd, project root, and limited tool metadata;
- a strict `approve`, `deny`, or `ask_user` JSON response.

The transcript, tool metadata, and project content are labeled as untrusted evidence. Recent user intent and bounded Pi compaction summaries are supplied separately so long-running sessions retain the agreed task context. Interactive sessions show an animated review status above the editor while the normal editor remains available for typing queued messages, then display each Automated Review decision, tool name, and bounded single-line reason; deterministic approvals remain quiet. Reviewer timeout, malformed output, missing configuration, or runtime failure falls back to User Confirmation when UI is available and denial otherwise. Caller cancellation denies without opening another prompt.

## Rule Advisor

`/auto-approval` can manually run an isolated Rule Advisor. It reviews up to 50 Friction Records from the last seven days, current rules, current Tool metadata, and skill names/descriptions, then returns at most 10 inactive Approval Rule Proposals. It can add rules or consolidate volatile external-Tool exact rules into one source-bound Tool-wide rule. The Advisor may recommend Project or eligible Global Scope, but candidates start unselected and show every rule they would replace before one atomic save.

Friction History is stored separately in `~/.pi/agent/auto-approval-friction.json`. Inputs are summarized before persistence (256-character strings, 10 array items, six levels, 4 KiB per record); Tool Results and conversation transcripts are never stored. The Advisor also supports cold-start suggestions for clearly low-risk external tools from the current Tool Catalog. The Reviewer Model and Global Tool pickers provide fuzzy search over their current catalogs.

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
