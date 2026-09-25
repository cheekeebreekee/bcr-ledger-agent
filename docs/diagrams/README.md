# Diagrams

These diagrams show the ledger agent's business logic, architecture and data flow. They are
written as Mermaid inside Markdown, so GitHub and VS Code render them and pull requests show
readable diffs.

This is WS7 PR-1 and contains only documentation. In Phase 1 a generator is ported from the
onboarding repo; see [Phase 1: the generator port](#phase-1-the-generator-port).

> **Handling D1.** [01-as-is.md](01-as-is.md) describes defects that can still be exploited on
> the live tenant until Phase 0 is deployed. Do not share it outside the dev team before then:
> no screenshots, slides or email, and do not paste it into tickets. The other diagrams describe
> controls, not weaknesses, and can be shared.

## The diagrams

| File | Id | Status | What it shows | Kind |
|---|---|---|---|---|
| [00-phase0-routing.md](00-phase0-routing.md) | P0 | PHASE-0 | Routing on today's code after containment: bot gate, strict source, two-pass Directory snapshot, bound client target or quarantine, no promotion, `conflictBehavior=fail`, the result card | flowchart |
| [01-as-is.md](01-as-is.md) | D1 | AS-IS, **private** | The flow before Phase 0, with defects X1 to X10 marked | flowchart |
| [02-target-business-logic.md](02-target-business-logic.md) | D2 | TARGET | Business logic: identity binding, dedupe, KSeF match, the 0.70 gate, review, learning, search, billing | flowchart |
| [03-target-architecture.md](03-target-architecture.md) | D3 | TARGET | Apps, identities, queues and permissions, and which identity may write SharePoint | flowchart |
| [04-target-data-flow.md](04-target-data-flow.md) | D4 | TARGET | Data flow across trust boundaries, and what crosses each edge | flowchart |
| [05-sequence-upload.md](05-sequence-upload.md) | D5 | TARGET | A client upload over the queue transport, including the picker and the KSeF match | sequence |
| [06-sequence-review.md](06-sequence-review.md) | D6 | TARGET | Manual review: ids-only card, the review app, and a move applied by ingestion | sequence |
| [07-sequence-ksef.md](07-sequence-ksef.md) | D7 | TARGET | Nightly KSeF sync for one client, and filing by ingestion | sequence |
| [08-data-model.md](08-data-model.md) | D8 | TARGET | The canonical index tables and their tenant keys | ER |

D2, D3 and D4 are copied verbatim from the approved plan, which holds the reconciled versions.
D5 to D8 follow the same reconciled design, including the review amendments that corrected
earlier drafts.

## Status labels

Each file names its status in its first paragraph.

| Label | Meaning |
|---|---|
| **AS-IS** | The code as it was before Phase 0 (`cbf1630`, 25 Sep 2026). Frozen: it is never updated, because it records what the incident review is about. |
| **PHASE-0** | What Phase 0 ships on today's code, with no database. It is interim: the TARGET design replaces it. |
| **TARGET** | The reconciled v2 design. None of it is built yet. When a workstream ships a flow, the PR that ships it updates the diagram and changes its label to IMPLEMENTED. |

Where CLAUDE.md or the code disagree with a TARGET diagram, CLAUDE.md and the code describe what
runs today.

## Colour key

Colour shows who acts. The palette is the one in the onboarding repo's diagram library, so
slides from both repos match.

| Class | Meaning | Fill | Stroke | Text |
|---|---|---|---|---|
| `client` | Client: a guest, a client Team, a client's folder | `#dbeafe` | `#2563eb` | `#0b2e6b` |
| `agent` | AI agent: Claude classification, learning, the future billing agent | `#e0e7ff` | `#4f46e5` | `#221a63` |
| `staff` | BCR staff: accountants, triage, the staff app and channel | `#dcfce7` | `#16a34a` | `#0d3b1e` |
| `system` | Ledger systems acting on their own: apps, queues, the database | `#f1f5f9` | `#64748b` | `#1e293b` |
| `external` | Outside services: Anthropic, KSeF | `#fef3c7` | `#d97706` | `#5a3608` |
| `gate` | An isolation gate or a store that must stay closed | `#fee2e2` | `#dc2626` | `#6b1414` |
| `defect` | A defect (D1 only): the gate colours with a thick border | `#fee2e2` | `#dc2626`, 3px | `#6b1414` |

Every flowchart starts with the same block. Copy it exactly:

```text
classDef client fill:#dbeafe,stroke:#2563eb,color:#0b2e6b
classDef agent fill:#e0e7ff,stroke:#4f46e5,color:#221a63
classDef staff fill:#dcfce7,stroke:#16a34a,color:#0d3b1e
classDef system fill:#f1f5f9,stroke:#64748b,color:#1e293b
classDef external fill:#fef3c7,stroke:#d97706,color:#5a3608
classDef gate fill:#fee2e2,stroke:#dc2626,color:#6b1414
```

D1 adds `classDef defect fill:#fee2e2,stroke:#dc2626,stroke-width:3px,color:#6b1414`.

Every red gate stands for an isolation invariant, and each invariant has a permanent regression
test (see [Gates and invariants](#gates-and-invariants)). A PR that changes a gate changes its
test in the same PR.

## Trust boundaries

- **Flowcharts.** A trust boundary is a subgraph with a red dashed border:
  `style <id> fill:#ffffff,stroke:#dc2626,stroke-width:2px,stroke-dasharray: 6 4`. Red means
  "must not cross this line". Where a boundary is only a grouping, the subgraph stays unstyled.
  D2 to D4 are verbatim copies of the plan and keep its plain subgraphs. In D4 every subgraph is
  a trust boundary. The Phase-1 generator versions draw them in red.
- **Sequence diagrams.** Participants are grouped in `box` blocks that mark whose side they are on:
  - blue `rgb(219,234,254)`: Microsoft 365 and the client's side (Teams, a client Team site);
  - grey `rgb(241,245,249)`: the ledger's own Azure apps, queues and database;
  - amber `rgb(254,243,199)`: external services (Anthropic, KSeF);
  - green `rgb(220,252,231)`: staff surfaces and the staff-only quarantine.
- **What crosses an edge.** D4 labels each edge with the letters B (document bytes), F (extracted
  fields), T (token or secret) and I (ids only).

## Mermaid safety rules

Mermaid parsers differ between GitHub, VS Code and mermaid-cli. These rules keep every diagram
rendering everywhere:

- Quote every label: `A["text"]`, `B{"text"}`, `A -->|"text"| B`, and `"text"` on ER relations.
- Never use `;`, `#` or `%` in any text, including sequence messages and notes.
- No `<` or `>` except `<br/>`. Write `≥`, `below` or `above` instead.
- Never use `end` as a node id. Mermaid reads it as the end of a subgraph.
- One diagram per fenced block, and at most about 40 nodes per diagram. Split a diagram that grows
  beyond that.
- No emoji in labels.
- Placeholders only, never real identifiers: Client A, Client B, Client X, `{driveId}`,
  `{folderItemId}`, `{batchId}`. That rules out NIPs and other tax ids, GUIDs, client numbers,
  tenant or site hostnames, SharePoint site paths, e-mail addresses and API key prefixes.

To check that every block parses before you commit, run mermaid-cli with your local Chrome. It
renders each block and fails on the first parse error:

```bash
mkdir -p /tmp/diagrams-out
PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npx -y @mermaid-js/mermaid-cli@11 -i docs/diagrams/05-sequence-upload.md -o /tmp/diagrams-out/05.md
```

## Gates and invariants

The red gates correspond to the isolation invariants in the plan. Each one gets a permanent
regression test from the workstream that builds it.

| Invariant | Rule | Shown in |
|---|---|---|
| I1 | A document is written only to the storage target of a client the uploader is bound to, or to the staff quarantine. One identity writes SharePoint. | P0, D2, D3, D5 |
| I2 | Content never changes the client. | P0 (no promotion), D2 (BIND), D5 |
| I3 | Ambiguity goes to quarantine, never to a guess. | P0, D2, D5 |
| I4 | Row-level security fails closed: no scope set means zero rows. | D3, D8 |
| I6 | Nothing identifies the user from a request body. Callers are pinned by app id. | P0, D3, D5 |
| I7 | Cards and logs never carry another client's URL, name or filename. Model free text is never shown to clients. | P0 (card rows), D5, D6 |
| I8 | Uploads never overwrite (`conflictBehavior=fail`). | P0, D5, D6, D7 |
| I9 | Staff are never client users. | D8 |
| I11 | Learning, dedupe, KSeF matching and search run inside one client's transaction. | D2, D5, D7 |
| I12 | A nightly isolation audit can block a target. | D3 |

I5 (scopes cannot be forged) and I10 (an active binding cannot change) are enforced in code and
in the database. No diagram draws them.

## Phase 1: the generator port

In Phase 1, WS7 PR-2 ports the onboarding repo's diagram generator (`tools/diagrams/lib.mjs` and
`tools/generate-diagrams.mjs`) into this repo:

- D1 to D4 become explicit-layout specs rendered to `.drawio`, `.svg` and `.png` for Roman's
  slides, because Mermaid's automatic layout of 20 to 30 nodes in nested subgraphs is
  unpredictable. The Mermaid copies of D1 to D4 are then replaced by embeds of the generated
  files, leaving one source of truth. An optional Polish D2 may follow.
- D5 to D8 stay as Mermaid, because they need `alt`, `loop`, `Note` and ER features the generator
  does not have.
- `yarn diagrams:generate` renders and `yarn diagrams:check` runs in CI. The check covers the
  palette, the safety rules above, a deny-list of real identifiers, a rule that every SharePoint
  write edge starts from the ingestion identity, a rule that no edge label uses a filename as a
  KSeF key, and D8 against the database migrations.
- Generated files in this folder are never hand-edited. The generator deletes any file here that
  its specs do not produce, so do not put other images in this folder.
