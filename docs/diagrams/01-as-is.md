# D1: The flow before Phase 0

> **Private: dev team only until Phase 0 is deployed.** This diagram describes defects that can
> still be exploited on the live tenant. Do not share it in slides, email or tickets, and do not
> share screenshots of it.

**Status: AS-IS.** The code at `cbf1630` on 25 Sep 2026, before Phase 0, with the defects found by
the audit marked X1 to X10. It is frozen and is never updated. Commit `21b0883` already points the
old fallback at the quarantine settings. [00-phase0-routing.md](00-phase0-routing.md) shows the
flow after Phase 0.

Defects use the `defect` class, a red box with a thick border. Other colours follow the
[README](README.md#colour-key).

```mermaid
flowchart TB
  classDef client fill:#dbeafe,stroke:#2563eb,color:#0b2e6b
  classDef agent fill:#e0e7ff,stroke:#4f46e5,color:#221a63
  classDef staff fill:#dcfce7,stroke:#16a34a,color:#0d3b1e
  classDef system fill:#f1f5f9,stroke:#64748b,color:#1e293b
  classDef external fill:#fef3c7,stroke:#d97706,color:#5a3608
  classDef gate fill:#fee2e2,stroke:#dc2626,color:#6b1414
  classDef defect fill:#fee2e2,stroke:#dc2626,stroke-width:3px,color:#6b1414

  U["Any tenant user: client guest, staff, unknown<br/>DM, team chat or group chat"]:::client
  subgraph AZ["Ledger Azure today: public endpoints, Linux Consumption Y1"]
    BOT["teams-bot app<br/>X7 no scope, tenant or user check"]:::defect
    ING["ingestion app<br/>X7 trusts source.userAadObjectId from the body"]:::defect
    P1{"Phase 1: uploader AAD id on a<br/>non-admin Directory row?"}:::gate
    TROW["Target = site written on that row<br/>Claude primed with that client"]:::system
    TFB["Target = fallback bucket"]:::defect
    CL["Claude opus-4-5, forced tool call<br/>X10 accepts at 0.6, below it the suggestion,<br/>parties and date are discarded"]:::agent
    P2{"X2 Phase 2, fallback only: exactly one<br/>Directory NIP among parties, any role?"}:::defect
    UP["Upload by path strings: host, site path,<br/>drive name, RootFolder, then a plain PUT"]:::system
    TAB["X5 GET /api/mydocs, anonymous<br/>trusts the userObjectId query parameter"]:::defect
    NOIDX["X9 No index: the file is the only record<br/>logs sampled, kept 30 days"]:::defect
  end
  AN["Anthropic API"]:::external
  ONB["X4 Onboarding step 13 writes a row with<br/>no UserAadObjectIds and RootFolder empty,<br/>site grant for the onboarding MI only"]:::defect
  subgraph M365["Microsoft 365 tenant BCR"]
    subgraph BCRG["X8 BCR GROUP team site, found Public on 23 Sep 2026"]
      CD[("X6 Client Directory list: editable,<br/>one ClientId on two rows,<br/>third duplicate key fails open")]:::defect
      FB["X1 Fallback bucket: Dokumenty library root<br/>unrouted files of every client"]:::defect
    end
    subgraph SA["Client A team site"]
      RA["X3 Library root 01_Faktury/...<br/>because RootFolder is empty"]:::defect
      CA["Channel folder Dokumenty księgowe<br/>Shared tab, never written"]:::system
    end
    subgraph SB["Client B team site"]
      RB["Library root 01_Faktury/..."]:::system
    end
  end

  U -->|"attachments via Bot Service"| BOT
  BOT -->|"POST /api/ingest/batch, bot secret JWT"| ING
  ING --> P1
  P1 -.->|"5 min cache, stale copy kept on failure"| CD
  ONB -->|"one row per client"| CD
  P1 -->|"yes"| TROW
  P1 -->|"no: every onboarded guest, staff, unknown"| TFB
  TROW --> CL
  TFB --> CL
  CL -->|"whole document"| AN
  CL --> P2
  P2 -->|"yes: move to that client, relabel sale or purchase"| UP
  P2 -->|"no, or not a fallback upload"| UP
  UP -->|"row target"| RA
  UP -->|"promoted by a NIP in the content"| RB
  UP -->|"still unrouted"| FB
  RA -.-|"not the folder the client looks at"| CA
  U -.->|"any GUID"| TAB
  UP -.-> NOIDX
  style BCRG fill:#ffffff,stroke:#dc2626,stroke-width:2px,stroke-dasharray: 6 4
```

## Defect key

Paths are in this repo unless marked **O** (the onboarding repo). Line numbers are at `cbf1630`.

| Mark | Defect | Evidence | Removed by |
|---|---|---|---|
| X1 | Unrouted uploads land in a fallback bucket at the root of the BCR GROUP team library, which every member of that team can read | `packages/document-ingestion/src/runtime.ts:34-45` | P0-2: the staff-only quarantine site. IR-1 and IR-2 inventory and relocate what already landed there. |
| X2 | Content-based promotion: a fallback upload moves to whichever client's NIP appears in the document, in any role. A crafted PDF can plant files in any client's space. | `packages/document-ingestion/src/services/clientResolver.ts:146-224` | P0-1: promotion deleted, guarded by a source-scan test |
| X3 | Files land at the library root, not in the channel folder the client sees | O `provisioning/clientDirectory.ts:92-94` | Phase 0: `directory-bindings.mjs` sets `RootFolder`. Phase 2: storage by id, plus the root migration. |
| X4 | Onboarding never records the guest's AAD id and grants the site only to the onboarding identity, so every onboarded client's upload counts as unknown | O `provisioning/clientDirectory.ts:85-104` | Phase 0: `directory-bindings.mjs` binds guests. Phase 2: onboarding v2 writes the binding through the registry. |
| X5 | The anonymous Personal Tab maps any user id to that user's client (IDOR) | `packages/teams-bot/src/functions/mydocs.ts:30-68` | P0-5 |
| X6 | Directory integrity: one ClientId on two rows, and the duplicate check fails open from the third duplicate on | `packages/document-ingestion/src/services/clientDirectoryReader.ts:275-292` | P0-4: the two-pass snapshot. Phase 2 moves routing into the database. |
| X7 | The bot accepts any conversation type and any tenant. Ingestion trusts the user id sent in the request body. | `teams-app/manifest.json:28`, `packages/document-ingestion/src/functions/validation.ts:21-30` | P0-3 (bot gate and strict source), P0-8 (caller pinning). Phase 3 replaces the HTTP route with a queue. |
| X8 | The BCR GROUP team was Public at the 23 Sep audit | O `docs/operations/client-access.md` | Tenant change, already made: the team is Private, intentionally. Audit check A12 verifies it read-only. |
| X9 | No index and no audit trail: the file is the only record, and logs are kept 30 days | the whole pipeline | Phase 2: the document index |
| X10 | Effective threshold 0.6, and below it the suggestion, parties and date are thrown away | `packages/document-ingestion/src/services/claudeClassifier.ts:130-137` | Phase 1: one acceptance policy at 0.70 that keeps the suggestion |
