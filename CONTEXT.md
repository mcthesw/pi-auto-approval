# Tool Approval

The language used by Pi Auto Approval to decide whether a proposed Pi tool operation may proceed.

## Language

**Tool Call**:
A proposed tool operation awaiting a decision before execution.
_Avoid_: Command, action

**Tool Identity**:
The combination of a tool name and its current source used to distinguish tools with the same name.
_Avoid_: Tool name, matcher

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
_Avoid_: Global Scope, current file

**Global Scope**:
The current user's cross-project boundary for explicitly global approval configuration.
_Avoid_: Project Scope, system-wide policy

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

**Approval Friction**:
The model cost or user attention consumed when a **Tool Call** requires **Automated Review**, **User Confirmation**, or both.
_Avoid_: Denial, execution cost

**Friction Record**:
A retained account of one **Tool Call** that incurred **Approval Friction**, including its review decision and any resulting user choice.
_Avoid_: Approval, audit log

**Friction History**:
A bounded project-scoped collection of recent **Friction Records** used to identify repeated approval friction.
_Avoid_: Approval list, full transcript

**Rule Advisor**:
An automated recommender that evaluates **Friction History** and produces zero or more **Approval Rule Proposals** without granting permission.
_Avoid_: Review Agent, automatic rule writer

**Approval Rule Proposal**:
An automatically generated matcher that remains inactive until the user reviews and accepts it.
_Avoid_: Automatic rule, implicit authorization

**Approval Rule**:
A user-accepted, editable matcher that authoritatively approves matching **Tool Calls** within its configured **Project Scope** or **Global Scope**.
_Avoid_: Safety policy, implicit permission

**Tool-wide Approval Rule**:
An **Approval Rule** that approves every input for one non-built-in **Tool Identity**.
_Avoid_: Unbound tool permission, built-in wildcard

## Relationships

- A **Project Scope** contains zero or more project-specific **Approval Rules**.
- The **Global Scope** contains zero or more **Tool-wide Approval Rules** and no other rule kind.
- A **Tool Identity** belongs to one current tool source.
- A **Tool-wide Approval Rule** applies to exactly one non-built-in **Tool Identity** and belongs to either one **Project Scope** or the **Global Scope**.
- An **Approval Policy** contains one or more ordered **Policy Rules**.
- A **Tool Call** may be classified by an **Approval Policy** or matched by an **Approval Rule**.
- One **Review Context** belongs to exactly one **Tool Call**.
- A **Review Agent** performs one **Automated Review** for one **Tool Call** using one **Review Context**.
- An **Automated Review** produces an **Approval**, **Denial**, or **User Confirmation**.
- **Approval Friction** is incurred when a **Tool Call** requires **Automated Review**, **User Confirmation**, or both.
- An eligible **Tool Call** that incurs **Approval Friction** may produce one **Friction Record** in its **Project Scope**.
- A **Friction Record** retains both the review decision and resulting user choice when both occur.
- A **Friction History** contains zero or more recent **Friction Records** from exactly one **Project Scope**.
- A **Rule Advisor** evaluates one **Friction History** and may produce zero or more **Approval Rule Proposals**.
- An **Approval** applies to exactly one **Tool Call**.
- A **Denial** applies to exactly one **Tool Call** and may carry **Denial Feedback**.
- A **User Confirmation** produces an **Approval**, a **Denial**, or an **Approval Rule** from the user.
- A **User Confirmation** may present one editable **Approval Rule Proposal**.
- An accepted **Approval Rule Proposal** becomes an **Approval Rule**.
- An **Approval Rule** applies to zero or more future matching **Tool Calls** in either one **Project Scope** or the **Global Scope**.
- A project **Approval Policy** takes precedence over **Global Scope** rules, while project-specific **Approval Rules** remain authoritative within their **Project Scope**.

## Example dialogue

> **Dev:** "The **Review Agent** is uncertain. Is that a **Denial**?"
> **Domain expert:** "No. It requests **User Confirmation** for this **Tool Call**."
> **Dev:** "What if the user chooses Always approve?"
> **Domain expert:** "Accepting the editable **Approval Rule Proposal** creates an **Approval Rule** for future matching calls in this **Project Scope**."
> **Dev:** "Can the **Rule Advisor** grant permission after finding repeated **Approval Friction** in **Friction History**?"
> **Domain expert:** "No. It can only propose a rule; the user must accept it."

## Flagged ambiguities

- “Approval” could mean safety certification or user-intent authorization; here it means one-time execution permission only.
- “Denial” could mean a permanent prohibition or a request for confirmation; here it terminates only the current call.
- “User Confirmation” can sound approval-biased; here it is a neutral user choice between approval and denial paths.
- **Policy Rule** classifies calls; **Approval Rule** is an authoritative user-created approval matcher.
- A matcher generated by a **Review Agent** or **Rule Advisor** is only an **Approval Rule Proposal** until explicitly accepted by the user.
- “审批列表” was ambiguous between all decisions and approved calls; use **Friction History**, which contains eligible calls that required **Automated Review**, **User Confirmation**, or both.
- A **Review Agent** decides one **Tool Call**; a **Rule Advisor** only recommends rules from multiple **Friction Records**.
- A **Tool-wide Approval Rule** is bound to both tool name and source so a replacement tool does not inherit broad approval.
- “Always approve” defaults to one **Project Scope**; only an explicit **Global Scope** choice for a **Tool-wide Approval Rule** applies across projects.
- **Sensitive Path** concerns private material; **Control Path** concerns state or behavior control, and a path may be both.
