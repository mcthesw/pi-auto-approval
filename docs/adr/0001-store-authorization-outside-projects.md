# Store authorization outside projects

Rules are stored in `~/.pi/agent/auto-approval.json`, grouped by project root, rather than in repository files. They grant execution authority, so a repository must not define its own authorization merely by being opened.
