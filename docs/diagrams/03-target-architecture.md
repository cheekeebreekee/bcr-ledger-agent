# D3: Target architecture and identities

**Status: TARGET.** The reconciled v2 design, copied verbatim from the approved plan. None of it
is built yet.

Each edge names the identity or role it uses. Colours follow the
[README](README.md#colour-key).

```mermaid
flowchart LR
  classDef client fill:#dbeafe,stroke:#2563eb,color:#0b2e6b
  classDef agent fill:#e0e7ff,stroke:#4f46e5,color:#221a63
  classDef staff fill:#dcfce7,stroke:#16a34a,color:#0d3b1e
  classDef system fill:#f1f5f9,stroke:#64748b,color:#1e293b
  classDef external fill:#fef3c7,stroke:#d97706,color:#5a3608
  classDef gate fill:#fee2e2,stroke:#dc2626,color:#6b1414
  G["Client guest<br/>Teams 1:1 DM"]:::client
  S["Accountant"]:::staff
  subgraph M365["Microsoft 365 tenant BCR"]
    BS["Azure Bot Service"]:::system
    TAB["Staff app BCR Weryfikacja<br/>Teams SSO"]:::staff
    CH["BCR GROUP, Private<br/>channel Weryfikacja dokumentów"]:::staff
    subgraph SPO["SharePoint, one private Team per client"]
      SPA["Client A Team site<br/>Dokumenty księgowe folder"]:::client
      SPB["Client B Team site<br/>Dokumenty księgowe folder"]:::client
      QS["Staff quarantine site<br/>no M365 group, sharing off"]:::gate
    end
  end
  subgraph VNET["Ledger Azure: VNet, Flex Consumption, private endpoints"]
    BOT["teams-bot, id-bcr-ledger-bot<br/>gate on every activity, client search"]:::system
    Q[["stbcrlq: staging blobs and queues<br/>ingest-requests, ingest-results,<br/>review-commands, ksef-file-commands"]]:::system
    ING["document-ingestion, id-bcr-ledger-ingest<br/>the only SharePoint writer, queue-driven"]:::system
    REV["review-api<br/>no Graph permission"]:::system
    KJ["ksef-sync<br/>no Graph permission, one static egress IP"]:::system
    REG["registry<br/>bindings API, membership sync"]:::system
    AUD["isolation-audit<br/>nightly, read-only"]:::gate
    PG[("PostgreSQL Flexible<br/>Entra-only, FORCE RLS")]:::system
    KVK["kv-ksef<br/>per-client KSeF tokens"]:::gate
  end
  ANT["Anthropic API<br/>claude-opus-5"]:::external
  KSEF["KSeF API 2.0"]:::external
  ONB["Onboarding step 13"]:::system
  AO["Onboarding Automation<br/>per-site grants, allow-listed apps"]:::system
  AA["aa-bcr-ledger Automation<br/>staff Team membership"]:::system
  G --> BS
  BS -->|"Bot Framework JWT"| BOT
  BOT -->|"write-only blob, queue send"| Q
  Q -->|"ids and staged bytes"| ING
  ING -->|"Sites.Selected write, by id"| SPA
  ING -->|"Sites.Selected write, by id"| SPB
  ING -->|"unbound uploads only"| QS
  ING -->|"classification"| ANT
  ING -->|"ledger_ingest"| PG
  BOT -->|"ledger_client_read, scope from identity"| PG
  BOT -->|"question to typed filter"| ANT
  S --> TAB
  TAB -->|"SSO JWT, Ledger.Reviewer, upn"| REV
  REV -->|"ledger_reviewer, assigned clients"| PG
  REV -->|"decision id only"| Q
  REV -->|"Workflows webhook, ids only"| CH
  S -.->|"own sign-in, Team member"| SPA
  KJ -->|"Secrets User, this vault only"| KVK
  KJ -->|"per-client token"| KSEF
  KJ -->|"ledger_ksef"| PG
  KJ -->|"ksef invoice id only"| Q
  ONB -->|"Ledger.Bindings.Write"| REG
  REG -->|"ledger_registry"| PG
  ONB --> AO
  AO -->|"grant write to ingest identity only"| SPB
  AA -->|"add or remove assigned accountants"| SPA
  AUD -->|"visibility, members, links, app grants"| SPB
  AUD -->|"findings, block target"| PG
```

## Reading notes

- **One SharePoint writer.** Only `document-ingestion`, running as `id-bcr-ledger-ingest`, writes
  to SharePoint: client folders by id, the quarantine site, KSeF filings and review moves (I1).
  `review-api` and `ksef-sync` hold no Graph permission. They put ids on the `review-commands` and
  `ksef-file-commands` queues, and ingestion does the work.
- **Ingestion is queue-driven.** After the cutover it exposes no HTTP route except `/api/health`.
  The bot writes the uploaded bytes to staging blobs it cannot read back, and sends the request on
  `ingest-requests`. The result comes back on `ingest-results` (I6).
- **Database roles.** Every caller has its own role (`ledger_ingest`, `ledger_client_read`,
  `ledger_reviewer`, `ledger_ksef`, `ledger_registry`). None of them owns tables or bypasses
  row-level security (I4).
- **Site grants.** The onboarding Automation account grants site write to the ingestion identity
  only. The ledger's own Automation account adds and removes assigned accountants as Team members.
- **KSeF credentials** live in `kv-ksef`, which only `ksef-sync` can read.
- **Isolation audit** runs nightly, read-only, and can block a target (I12).
- **Pending:** the onboarding-to-registry binding edge needs Roman to re-rule Q21.
