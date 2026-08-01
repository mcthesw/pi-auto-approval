# Layer deterministic policy before isolated automated review

Each Tool Call first checks authoritative project-scoped Approval Rules, then applies the first matching rule in an ordered deterministic Approval Policy whose routes are approve, deny, ask_user, or auto_review. Only auto_review creates a fresh tool-less in-memory Review Agent session with bounded untrusted context; this keeps known decisions predictable and cheap while reserving model judgment for residual cases without re-entering the main Pi session.
