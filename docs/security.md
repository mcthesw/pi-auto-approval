# Security model

Pi Auto Approval is an authorization layer for Pi Tool Calls. It is not a sandbox and does not certify that an approved call is safe, correct, or aligned with the user's intent.

## Trust boundary

The trusted computing base includes:

- Pi and the host Node.js process;
- this extension and all other installed Pi extensions;
- configured model providers and credentials;
- the user's global Pi settings and Auto Approval configuration;
- system executables and the operating-system environment outside the project.

Pi extensions execute arbitrary code with the user's system permissions. Another extension can perform side effects without emitting a Tool Call, or can alter behavior after this extension has approved a call. Install only trusted extensions.

The `tool_call` hook is a pre-execution decision point, not an operating-system security boundary. There is no filesystem, process, or network sandbox behind an Approval.

## Authorization precedence

A user-accepted project Approval Rule is authoritative for every matching Tool Call. It runs before Policy Rules and built-in defaults. Broad rules can therefore approve broad effects; the user owns the scope they accept.

Policy Rules are ordered and first-match-wins. They can narrow built-in defaults by routing selected calls to `deny`, `ask_user`, or `auto_review`, or widen them with `approve`.

Configuration is never loaded from the repository being authorized. An invalid configuration file does not fall back to permissive defaults.

## Filesystem boundary

Project-relative path rules use a canonical Git root, or canonical cwd outside Git. Existing symlinks and junctions are resolved. For a path that does not exist, the nearest existing ancestor is resolved before the remaining suffix is checked.

This reduces common path-escape mistakes but cannot eliminate time-of-check/time-of-use races. A path or ancestor can change between authorization and tool execution. Control Paths receive more conservative built-in handling, but an explicit Approval Rule can still authorize them.

Sensitive filenames such as `.env` are not guessed by default. Configure a higher-priority Policy Rule when a project requires them to be denied, confirmed, or reviewed.

## Bash boundary

Deterministic Bash approval is deliberately narrow. The classifier rejects unsupported syntax, substitutions, expansions, redirections, background execution, environment assignments, unknown wrappers, unsafe options, and unresolved executables. Git and `file` commands are never deterministically approved because repository/configuration hooks and option combinations can execute programs or write files.

Before deterministic approval, the extension also rejects relevant startup/configuration environment variables, project-local `PATH` entries, Pi `shellCommandPrefix`, and custom `shellPath`. External command resolution is checked with a clean non-interactive Bash lookup and must not resolve inside the project.

These checks are best-effort hardening, not process isolation. Shell parsing and executable behavior vary across platforms and versions. Calls that cannot be proven to fit the supported subset route to Automated Review; model approval still does not create an OS sandbox.

## Automated Review boundary

The Reviewer receives untrusted evidence, not instructions:

- exact current Tool Call JSON, subject to a hard size limit;
- bounded transcript excerpts;
- cwd and project root;
- limited metadata for the current tool.

Every review uses a fresh in-memory session with no tools or project resources. Reviewer conversation state is not reused. The fixed policy cannot be replaced through project content or configuration.

Model judgment can be wrong. A Reviewer Approval permits only the current Tool Call. A proposed persistent matcher remains inactive until the user accepts it in User Confirmation.

Dynamic providers registered by other extensions are not available to the isolated Reviewer runtime in the initial release. Built-in providers and providers configured through Pi's model configuration are supported.

## Failure behavior

- Invalid configuration: User Confirmation with UI, denial without UI.
- Missing or unavailable Reviewer: User Confirmation with UI, denial without UI.
- Timeout, malformed response, or oversized Tool Call: User Confirmation with UI, denial without UI.
- Caller cancellation: denial without opening another prompt.
- Failed persistent-rule write after explicit approval: the current call remains approved, but the UI reports that the future rule was not saved.

No hidden circuit breaker overrides an accepted Approval Rule.
