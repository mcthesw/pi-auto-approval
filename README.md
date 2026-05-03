# pi-extension-safety-guard

Interactive safety prompts for high-risk operations in Pi.

## What it does

- Intercepts dangerous `bash` commands and requires confirmation.
- Intercepts `write`/`edit` on protected paths and requires confirmation.
- In non-interactive mode, blocks risky operations with explicit reasons.

Default dangerous command patterns include:
- `rm -rf`, `sudo`, `mkfs`, `dd`
- `shutdown`, `reboot`, `poweroff`
- common fork-bomb signature

Default protected-path patterns include:
- `.ssh`, `.git-credentials`, `auth.json`
- `id_rsa`, `id_ed25519` (and `.pub`)
- `.env` and `.env.*`

## Install

```bash
pi install npm:@firstpick/pi-extension-safety-guard
```

## Configuration

No required configuration.

## Commands

None.

## Tools

None.
