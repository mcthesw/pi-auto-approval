# Store authorization outside projects

Approval Rules and configurable Policy Rules are stored in `~/.pi/agent/auto-approval.json`, grouped by project root, rather than in repository files. These rules grant execution authority, so allowing repository content to define them would let a project authorize its own tool calls; centralized user-owned storage preserves project scope without crossing that trust boundary.
