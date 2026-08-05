# Tool Approval

The language used by Pi Auto Approval to decide whether a proposed Pi tool operation may proceed.

## Language

**Tool Call**:
A proposed tool operation awaiting a decision before execution.
_Avoid_: Command, action

**Tool Identity**:
A tool name, optionally constrained to the source that currently provides it.
_Avoid_: Tool name, matcher

**Rule**:
A user-owned future-call instruction with a **Rule Action** and a **Tool Matcher** in either **Project Scope** or **Global Scope**.
_Avoid_: Approval Rule, Policy Rule, trusted tool

**Rule Action**:
One of **Allow**, **Ask**, or **Deny**.
_Avoid_: Route, auto-review action

**Allow**:
A Rule Action that permits a matching **Tool Call** without another decision.
_Avoid_: Safety certification, blanket trust

**Ask**:
A Rule Action that requests **User Confirmation** for a matching **Tool Call**.
_Avoid_: Automated Review

**Deny**:
A Rule Action that prevents one matching **Tool Call** from executing.
_Avoid_: Permanent ban

**Tool Matcher**:
The tool and structured input constraints used by a **Rule** to identify future **Tool Calls**.
_Avoid_: Regex, arbitrary expression

**Project Scope**:
The project boundary to which a **Rule** applies.
_Avoid_: Current file

**Global Scope**:
The current user's cross-project boundary for an explicitly global **Rule**.
_Avoid_: System sandbox

**User Confirmation**:
A request for the user to choose whether one specific **Tool Call** may execute.
_Avoid_: Assumed consent

**Reviewer**:
An isolated automated decision-maker that evaluates one **Tool Call** when no Rule or minimal default resolves it.
_Avoid_: Main Agent, sandbox

**Friction Record**:
A bounded, lossy record of a **Tool Call** that required review or confirmation.
_Avoid_: Audit log, transcript copy

**Rule Advisor**:
An isolated recommender that turns repeated **Friction Records** into inactive **Rule Suggestions**.
_Avoid_: Automatic rule writer

**Rule Suggestion**:
A proposed **Rule** that does nothing until the user explicitly selects and saves it.
_Avoid_: Automatic authorization
