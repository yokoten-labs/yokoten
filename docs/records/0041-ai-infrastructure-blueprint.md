# 0041 The blueprint: yokoten is trust infrastructure for AI agents

Status: accepted (the direction; each part gets its own record before it is built)
Date: 2026-10-25 (UTC)

## Context

AI agents can do real work, but people do not yet hand it to them, and a company does not
let someone else's agent touch its code. The web had the same gap before TLS and
certificate authorities let strangers trust each other. Records
[0028](0028-a-trust-layer.md) to [0031](0031-the-boards-attention.md) already decide that
yokoten is a neutral trust layer, with an open standard, a provenance ledger, one event
log, and autonomy earned from a record. Record [0040](0040-one-codebase-platform-layer.md)
decides how one codebase serves every place an agent runs.

What was missing is the one shape that ties them together, and the order to build it in.
The owner agreed on 2026-10-25: "we build AI infrastructure".

## Decision

### 1. yokoten is a kernel for agents

An operating system stands between programs and the hardware: every call goes through
the kernel, which checks it against permissions, and drivers make one program run on many
machines. yokoten stands between AI agents and the world in the same way. Every action an
agent takes goes through one decision engine. Record 0040's adapters are its drivers.

### 2. One action model

The guard decides on **actions**, not on raw text. An action says who acts (vendor, model,
role, session), what it does, where (the place from record 0040), and on what evidence.
Decoders turn each kind of input into actions:

| Decoder | Turns into actions |
|---|---|
| Shell readers | bash, PowerShell, cmd commands |
| Edits | file writes and deletes |
| Network | outgoing requests (the desk proxy already sees them) |
| MCP | tool calls |
| Payments | money an agent spends (#640) |

A new kind of action is a new decoder. The rules stay as they are. A decoder that cannot
read its input refuses it (record 0040, rule 6).

### 3. Grants with a scope and an end

An owner's approval becomes a signed grant: who may do what, where, until when. For
example, "this worker may push this branch today". A tier A approval is one such grant.
Grants go into the event log ([0029](0029-a-control-plane.md)), and autonomy levels
([0030](0030-earned-autonomy.md)) decide which grants an agent can get without asking.

### 4. Four layers, near to far

| Layer | What it is | Built from |
|---|---|---|
| Kernel | On one machine, every agent action goes through one set of rules | The action model, record 0040's adapters, the guard protocol ([0039](0039-the-guard-protocol.md)) |
| Factory | In one team, agents from many vendors work under one set of rules | Signed team rules, locks, budgets, grants, the control plane (0029) |
| Network | Between teams, trust comes from evidence | The open protocol and the provenance ledger (0028), signed evidence, certification |
| Economy | Agents become parties that do paid work | Below |

The economy layer adds four things. Each one stands on evidence that the kernel already
writes.

- **Reputation** goes with an agent across vendors (0030, made portable).
- **Payment on evidence**: work is paid (x402) when its evidence checks out. The owner's
  spending limit (#640) is the first piece.
- **Compliance**: audits such as the EU AI Act and SOC 2 ask what an AI did. The event log
  is that record.
- **Assurance**: verifiable evidence lets someone stand behind an agent's work.

### 5. An open protocol, like LSP

LSP turned "every editor times every language" into "every editor plus every language".
The guard protocol does the same for any agent, any rule set and any place. A tool that
speaks it is guarded, and needs no adapter written by yokoten. The protocol is proven on
our own agents (Claude Code, Muse, DeepSeek) before it is published as a spec.

### 6. The order

| Version | Work |
|---|---|
| v0.1.2 | Record 0040's paths and processes (they fix safety bugs); the team runner (#823) |
| v0.2.0 | All of record 0040's adapters; the action model for shell commands; the agent capability table; Windows CI all green |
| v0.3.0 | Rules as data (CEL, #899); an optional long-running guard service with a fall-back to one process per call; the PowerShell reader |
| Later | Grants, signed evidence, the adapter kit for other vendors, one signed executable per system, the Windows sandbox, then the network and economy layers |

## Options not taken

- **A tool, not infrastructure.** A guard for one agent is easy to copy and is replaced
  when the vendor ships its own. A neutral layer across vendors is what no single vendor
  can be (0028).
- **Write the full spec first.** Standards win by use, not by design. The protocol grows
  from what our own agents run.
- **A new framework layer.** Records 0028 to 0031 stay the framework. The action model is
  the guard's input widened, and the four layers are those records in build order.

## Consequences

- Every new feature answers one question: which layer is it in, and what evidence does it
  write?
- The hardest thing to copy is a guard that has never let a harmful action through. Safety
  bugs such as #999 stay first, ahead of every feature.
- The smallest MVP comes first ([0035](0035-the-safeguard-is-the-mvp.md)). During the
  hackathon (from 2026-10-26) no code moves for this plan. The plan is the pitch's
  "future" page.
- Each part in the order table gets its own record and issue before it is built.
