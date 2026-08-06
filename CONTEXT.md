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
An isolated automated decision-maker that evaluates **Review-Eligible Tool Calls**.
_Avoid_: Main Agent, sandbox

**Review-Eligible Tool Call**:
A **Tool Call** for which neither a **Rule** nor a minimal default has returned Allow, Ask, or Deny.
_Avoid_: An Ask Rule match

**Review Batch**:
The **Review-Eligible Tool Calls** emitted by one assistant tool-calling message, evaluated by one **Reviewer** request while retaining an independent decision for each call.
_Avoid_: One shared authorization decision

**Correction Retry**:
One request within the same isolated model session to repair an invalid structured response without changing the original request or authorization boundary.
_Avoid_: A new review, a permission retry

**Model Run**:
One isolated **Reviewer** or **Rule Advisor** operation, including any **Correction Retry** and its combined **Model Usage**.
_Avoid_: Tool Call, Friction Record, model request

**Model Usage**:
The reported token consumption and estimated monetary cost attributable to one **Model Run**.
_Avoid_: Exact bill, Tool Call cost

**Friction Record**:
A bounded, lossy record of a **Tool Call** that required review or confirmation.
_Avoid_: Audit log, transcript copy

**Rule Advisor**:
An isolated recommender that turns repeated **Friction Records** into inactive **Rule Suggestions**.
_Avoid_: Automatic rule writer

**Rule Suggestion**:
A proposed **Rule** that does nothing until the user explicitly selects and saves it.
_Avoid_: Automatic authorization

## Relationships

- One **Reviewer** Model Run evaluates exactly one **Review Batch**.
- One **Rule Advisor** Model Run analyzes one or more **Friction Records** and produces zero or more **Rule Suggestions**.
