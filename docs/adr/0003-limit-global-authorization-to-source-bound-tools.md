# Limit global authorization to source-bound tools

Some external tools, such as read-only documentation services, have the same risk profile in every project. Requiring a separate project rule for each one creates repeated approval work, but allowing arbitrary command, path, or input matchers globally would make one project's authorization silently affect unrelated work.

Pi Auto Approval therefore permits Global Approval Rules only for an entire non-builtin Tool identified by both its name and Pi source identity. The source identity is part of the match so a same-name replacement does not inherit authorization. Project Policy Rules run before these global rules, allowing a project to require denial, confirmation, or review; project Approval Rules remain authoritative first.

Specific command, path, field, and exact-input matchers remain project-scoped. The configuration keeps version 1 and adds an optional top-level `globalApprovalRules` array, so existing files need no migration.
