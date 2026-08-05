# Security model

Pi Auto Approval is an authorization layer for Pi Tool Calls. It is not a sandbox and does not certify that an allowed call is safe, correct, or aligned with the user's intent.

## Trust boundary

The trusted computing base includes Pi, the host Node.js process, this and every installed extension, configured model providers and credentials, the user's Pi settings and Auto Approval configuration, and the operating-system environment.

Pi extensions run with the user's system permissions. Another extension can make side effects without emitting a Tool Call, or alter behavior after this extension allows one. Install only extensions you trust.

The `tool_call` hook is a pre-execution authorization point, not an operating-system boundary. There is no filesystem, process, or network sandbox behind an Allow decision.

## Rules and precedence

Every persisted Rule has one matcher, one action (`allow`, `ask`, or `deny`), and Project or Global Scope.

1. Matching Project Rules decide first.
2. If none match, matching Global Rules decide.
3. Minimal built-in defaults decide ordinary project-local file operations.
4. Residual calls go to the isolated Reviewer.

Within one scope, all matching Rules are considered; `deny > ask > allow`. This intentionally lets a user add a narrow restriction without reordering an approval list. Identical matchers are unique within a scope.

Users can deliberately create broad Global Rules. This is explicit authorization, not a safety guarantee. New Rules for non-standard tools bind reliable Pi source identity automatically when available, preventing a same-name replacement from silently inheriting the Rule. Existing version 1 exact rules without a source retain their original name-based behavior after migration.

Configuration is never loaded from the project being authorized. An invalid configuration does not fall back to permissive defaults.

## Paths and Bash

Project path matching starts from a canonical Git root, or canonical cwd outside Git. Existing symlinks and junctions are resolved; for a non-existing target, the nearest existing ancestor is resolved before its remaining suffix is checked. This reduces common path-escape mistakes but cannot eliminate time-of-check/time-of-use races.

Project path globs are relative to that root. Global path globs must be absolute or home-anchored and compare against the canonical target path. `.git`, `.pi`, `.agents`, and `AGENTS.md` use more conservative built-in defaults, but an explicit Rule can still authorize them. `.env` is not guessed as sensitive; add an Ask or Deny Rule when a project needs that handling.

Bash has no hidden command allowlist. Pi Auto Approval only conservatively tokenizes syntax with visible execution structure in order to apply explicit Rules segment by segment. Unsupported syntax, expansions, globs, redirections, assignments, and an unresolved segment go to the Reviewer unless a whole-call Exact or explicit all-input Rule matches the original call.

## Reviewer

The Reviewer receives untrusted evidence, not instructions:

- exact current Tool Call JSON for each item in a Review Batch;
- bounded transcript excerpts and recent user intent shared by that batch;
- explicit cwd and project root;
- limited metadata for every reviewed tool.

A Review Batch contains only the Review-Eligible calls from one assistant tool-calling message. It preserves source order and caps one request at 16 calls or 256KiB of exact Tool Call JSON; an individual call over the existing 64KiB limit goes directly to User Confirmation without blocking its siblings. The Reviewer must return one independently validated decision for every input ID. A saved Rule is re-evaluated before every sibling runs, so it immediately takes precedence over a cached Batch result.

Every review creates a fresh in-memory session with no tools or project resources. Its operational cwd is the filesystem root because Pi appends session cwd to custom system prompts; the actual project cwd is supplied only as marked untrusted evidence. The Reviewer can allow a one-time project-external read or write when user intent is clear. It can also be wrong; that is why it does not create an OS boundary.

When a structured Reviewer or Rule Advisor response is invalid, the same isolated session receives one fixed correction request within the original 60-second budget. A Reviewer Batch remains all-or-nothing: a second invalid response makes every item ask with UI and deny without it. Missing configuration, timeouts, runtime failure, and oversized Tool Calls also ask with UI and deny without it. Caller cancellation denies without another prompt. An invalid Rule suggestion is discarded independently of an otherwise valid Reviewer decision; confirmation falls back to a Project Exact Rule.

## Advisor and history

The Rule Advisor is manually invoked. It receives bounded, lossy Friction History and returns inactive Rule Suggestions. Suggestions never change authorization until the user actively selects and saves them.

History lives separately in `~/.pi/agent/auto-approval-friction.json`. Each project retains at most 50 records from seven days. Records include Tool name, source identity when available, Reviewer decision, user choice, and a bounded input summary; they never retain Tool Results or the main conversation transcript. Corrupt or unavailable history disables only Advisor evidence, not the current authorization decision.

## Failure behavior

- Invalid configuration: User Confirmation with UI, denial without UI.
- Missing or unavailable Reviewer: User Confirmation with UI, denial without UI.
- Failed persistent Rule write after explicit approval: the current call remains allowed and the UI reports the save failure.

No hidden circuit breaker overrides an explicitly accepted Rule.
