# D4: Target data flow and trust boundaries

**Status: TARGET.** The reconciled v2 design, copied verbatim from the approved plan. None of it
is built yet.

**Amended 29 September 2026.** The client node said "client guest". Since the owner's decision
of 28 September a client's identity is its `{NIP}@bcr-group.pl` account, an Entra Member created
by BCR; guests have no capability in the ledger. The rest is the plan as approved.

Each subgraph is a trust boundary. Each edge label says what crosses it:

| Letter | Meaning |
|---|---|
| B | Document bytes |
| F | Extracted fields |
| T | A token or secret |
| I | Ids only |

```mermaid
flowchart LR
  classDef client fill:#dbeafe,stroke:#2563eb,color:#0b2e6b
  classDef staff fill:#dcfce7,stroke:#16a34a,color:#0d3b1e
  classDef system fill:#f1f5f9,stroke:#64748b,color:#1e293b
  classDef external fill:#fef3c7,stroke:#d97706,color:#5a3608
  classDef gate fill:#fee2e2,stroke:#dc2626,color:#6b1414
  subgraph TB1["Client device, untrusted input"]
    CG["Client account"]:::client
  end
  subgraph TB2["Microsoft 365 tenant BCR"]
    BSV["Bot Service"]:::system
    subgraph TBA["Client A private Team"]
      FA["A: Dokumenty księgowe"]:::client
    end
    NEVER{{"Nothing crosses between clients:<br/>bytes, fields, ids, prompts, search results"}}:::gate
    subgraph TBB["Client B private Team"]
      FB["B: Dokumenty księgowe"]:::client
    end
    QS["Staff quarantine site"]:::gate
    CH["Weryfikacja dokumentów channel"]:::staff
  end
  subgraph TB3["Ledger VNet, private endpoints"]
    BOT["teams-bot"]:::system
    STG["staging blobs and queues"]:::system
    ING["ingestion, only SharePoint writer"]:::system
    REV["review-api"]:::system
    KJ["ksef-sync"]:::system
    DB[("PostgreSQL, RLS")]:::system
    KVK["kv-ksef"]:::gate
  end
  subgraph TB4["Anthropic, US sub-processor"]
    ANT["Messages API"]:::external
  end
  subgraph TB5["KSeF, Ministry of Finance"]
    KS["KSeF API"]:::external
  end
  subgraph TB6["Staff device"]
    ACC["Accountant"]:::staff
  end
  CG -->|"B + I from Teams sign-in"| BSV
  BSV -->|"B + I, Bot Framework JWT"| BOT
  BOT -->|"B to staging, I on queue"| STG
  STG -->|"B + I"| ING
  ING -->|"B of client X, X name and NIP, X memory"| ANT
  ANT -->|"F + usage"| ING
  ING -->|"F + I + usage, scoped to X"| DB
  ING -->|"B, by X driveId and folderItemId"| FA
  ING -->|"B, unbound uploads only"| QS
  ING -->|"I + Polish labels + X webUrl"| STG
  STG -->|"result card"| BOT
  BOT -->|"question text only"| ANT
  BOT -->|"typed filter, scope from identity"| DB
  ACC -->|"T SSO token + decision"| REV
  REV -->|"F + webUrl, assigned clients only"| ACC
  ACC -.->|"B, own SharePoint sign-in"| FA
  REV -->|"I: decision id"| STG
  REV -->|"I only"| CH
  KVK -->|"T of X, KSeF identity only"| KJ
  KJ -->|"T, fixed egress IP"| KS
  KS -->|"encrypted XML + metadata"| KJ
  KJ -->|"F + XML under X scope"| DB
  KJ -->|"I: ksef invoice id"| STG
  FA -.- NEVER
  NEVER -.- FB
```

## Reading notes

- **Nothing crosses between clients.** No bytes, fields, ids, prompts or search results pass
  from one client's Team to another's. The `NEVER` node stands for that rule.
- **Anthropic** receives the bytes of one client X, with X's name, NIP and memory. The cached
  prompt prefix contains no client data, so it is byte-identical across clients (I11).
- **Staff** open files with their own SharePoint sign-in. The review app returns fields and a
  link, never the bytes.
- **Queues and the staff channel** carry ids only (I7).
- **KSeF**: the token of client X is read only by the KSeF identity. The KSeF job stores
  fields and XML under X's scope and puts only an invoice id on the queue. Ingestion then files the
  PDF and XML (see [D7](07-sequence-ksef.md)).
