# Tool Approval

The language used by Pi Auto Approval to decide whether a proposed Pi tool operation may proceed.

## Language

**Tool Call**:
A proposed tool operation awaiting a decision before execution.
_Avoid_: Command, action

**Approval**:
One-time permission for one specific **Tool Call** to execute, without certifying its safety or correctness or authorizing future calls.
_Avoid_: Safety certification, blanket permission

**Denial**:
A final decision that prevents one specific **Tool Call** from executing without forbidding later calls.
_Avoid_: Permanent ban, user confirmation

**Denial Feedback**:
Optional user guidance attached to a **Denial** to tell the Main Agent how to proceed differently.
_Avoid_: Required justification, review rationale

**User Confirmation**:
A request for the user to choose whether one specific **Tool Call** may execute when no automatic decision is made.
_Avoid_: User escalation, assumed consent

**Project Scope**:
The project boundary to which project-specific approval configuration applies.
_Avoid_: Global scope, current file

**Sensitive Path**:
A path explicitly classified as likely to contain credentials, secrets, or other private material.
_Avoid_: Control Path, dangerous file

**Control Path**:
A path whose contents control repository state or future Pi behavior.
_Avoid_: Sensitive Path, ordinary configuration

**Policy Rule**:
An ordered matcher that assigns one handling route to matching **Tool Calls**.
_Avoid_: Approval Rule, unordered permission

**Approval Policy**:
A deterministic collection of **Policy Rules** that classifies **Tool Calls** before automated review.
_Avoid_: Approval Rule, risk model

**Review Context**:
Bounded untrusted evidence supplied for the review of one **Tool Call**.
_Avoid_: Full session copy, generated project summary

**Review Agent**:
An automated decision-maker that evaluates one **Tool Call** from a **Review Context** without executing it.
_Avoid_: Main Agent, policy engine

**Automated Review**:
An evaluation performed by the **Review Agent** that returns an **Approval**, **Denial**, or **User Confirmation**.
_Avoid_: User confirmation, policy match

**Approval Rule Proposal**:
A Review Agent-generated matcher that remains inactive until the user reviews and accepts it.
_Avoid_: Automatic rule, implicit authorization

**Approval Rule**:
A user-accepted, editable matcher that authoritatively approves matching **Tool Calls** within one **Project Scope**.
_Avoid_: Global allow-list, safety policy

## Relationships

- A **Project Scope** contains zero or more **Approval Rules**.
- An **Approval Policy** contains one or more ordered **Policy Rules**.
- A **Tool Call** may be classified by an **Approval Policy** or matched by an **Approval Rule**.
- One **Review Context** belongs to exactly one **Tool Call**.
- A **Review Agent** performs one **Automated Review** for one **Tool Call** using one **Review Context**.
- An **Automated Review** produces an **Approval**, **Denial**, or **User Confirmation**.
- An **Approval** applies to exactly one **Tool Call**.
- A **Denial** applies to exactly one **Tool Call** and may carry **Denial Feedback**.
- A **User Confirmation** produces an **Approval**, a **Denial**, or an **Approval Rule** from the user.
- A **User Confirmation** may present one editable **Approval Rule Proposal**.
- An accepted **Approval Rule Proposal** becomes an **Approval Rule**.
- An **Approval Rule** applies to zero or more future matching **Tool Calls** in exactly one **Project Scope**.

## Example dialogue

> **Dev:** "The **Review Agent** is uncertain. Is that a **Denial**?"
> **Domain expert:** "No. It requests **User Confirmation** for this **Tool Call**."
> **Dev:** "What if the user chooses Always approve?"
> **Domain expert:** "Accepting the editable **Approval Rule Proposal** creates an **Approval Rule** for future matching calls in this **Project Scope**."

## Flagged ambiguities

- “Approval” could mean safety certification or user-intent authorization; here it means one-time execution permission only.
- “Denial” could mean a permanent prohibition or a request for confirmation; here it terminates only the current call.
- “User Confirmation” can sound approval-biased; here it is a neutral user choice between approval and denial paths.
- **Policy Rule** classifies calls; **Approval Rule** is an authoritative user-created approval matcher.
- Review Agent-generated matcher text is only an **Approval Rule Proposal** until explicitly accepted by the user.
- “Always approve” applies within one **Project Scope**, not globally or irrevocably.
- **Sensitive Path** concerns private material; **Control Path** concerns state or behavior control, and a path may be both.
