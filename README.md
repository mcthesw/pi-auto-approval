# Pi Auto Approval

> [!WARNING]
> This project is under active development. Its current runtime is still the imported Safety Guard baseline and does not yet implement the architecture described below. No Pi Auto Approval package has been released.

A [Pi](https://github.com/badlogic/pi-mono) extension for approving tool calls with deterministic project policies and isolated model review.

## Target decision flow

```text
Tool Call
  -> project Approval Rules
  -> deterministic Approval Policy
       -> approve
       -> deny
       -> ask_user
       -> auto_review
            -> approve | deny | ask_user
```

The intended design keeps explicit user authorization authoritative, handles known cases deterministically, and sends only residual cases to a fresh tool-less Review Agent session. If automated review is unavailable, interactive sessions ask the user and non-interactive sessions deny the call.

See [`CONTEXT.md`](CONTEXT.md) for the project language and [`docs/adr`](docs/adr) for architectural decisions.

## Development

Run the imported baseline tests directly without installing peer dependencies:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --experimental-strip-types \
  --test tests/*.test.mjs
```

## Provenance

This repository was extracted with history from [`Firstp1ck/pi-coding-agent-forge/pi-extension-safety-guard`](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-extension-safety-guard). It retains the original MIT license and copyright notice.
