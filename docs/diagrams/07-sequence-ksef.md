# D7: Nightly KSeF sync for one client

**Status: TARGET.** The KSeF sync from Phase 4. None of it is built yet.

The KSeF job has **no Graph permission**. It stores invoices under the client's scope and puts
only a KSeF invoice id on the `ksef-file-commands` queue. Ingestion, the only SharePoint writer,
loads the XML under the client's scope, checks it again, renders the PDF and files both. Boxes
follow the [README](README.md#trust-boundaries).

```mermaid
sequenceDiagram
  autonumber
  box rgb(254,243,199) External
    participant K as KSeF API 2.0
  end
  box rgb(241,245,249) ksef-sync app, no Graph permission
    participant TM as KSeF timers
    participant KQ as ksef-sync queue
    participant W as KSeF worker
    participant KV as kv-ksef vault
  end
  box rgb(241,245,249) Ledger Azure
    participant DB as PostgreSQL with RLS
    participant FQ as ksef-file-commands queue
    participant I as ingestion, the only SharePoint writer
  end
  box rgb(219,234,254) Client X Team site
    participant SP as Graph and SharePoint
  end

  TM->>K: Latarnia status and GET /rate-limits before the run
  TM->>DB: ksef_list_enabled_clients() returns ids of KSeF-enabled, active clients only
  TM->>KQ: one message per client and enabled subject type, by default Subject1 and Subject2
  KQ->>W: dequeue client X with one subject type
  W->>DB: per-client lease, SET LOCAL app.client_id X, read the X NIP, ksef_links and the ksef_sync_state cursor
  W->>KV: GET secret ksef-token-{clientId}, tags must match X
  W->>K: challenge, token encrypted with RSA-OAEP for context NIP X, poll, redeem
  K-->>W: access and refresh tokens, held in memory only, never logged
  W->>W: tripwire: the clientIp in the challenge response must equal the fixed egress IP
  W->>K: GET /tokens/{ref}: context NIP is X and permissions are exactly InvoiceRead
  Note over W,K: any mismatch marks the link BROKEN and raises an alert. No automatic retry
  W->>K: POST /invoices/exports for this subject type, PermanentStorage from the cursor, restrictToPermanentStorageHwmDate true, no end date
  W->>K: poll the export by re-enqueue, honouring Retry-After
  W->>K: download parts, verify hashes, AES-256-CBC decrypt, unzip with size and entry-name guards
  W->>W: per invoice: sha256 of the XML equals invoiceHash, KSeF number prefix equals the seller NIP
  W->>W: tenant check: X NIP in the requested role in BOTH the metadata and the XML
  alt any invoice fails a check
    Note over W: abandon the WHOLE package: nothing persisted, cursor unchanged, link BROKEN, Sev1 alert with ids only
  else the whole package passes
    W->>DB: upsert ksef_invoices and ksef_invoice_xml on client_id and ksef_number, deterministic FA(2) or FA(3) parse, no LLM
    loop each invoice, same client only
      alt QR hash, or text-layer KSeF number agreeing on seller NIP, gross and date, or a business key with exactly one candidate
        W->>DB: ksef_link_document enriches the bot upload, filing_status LINKED, label written as definer
        Note over W,DB: the KSeF XML is still filed next to the linked bot upload
      else unmatched
        W->>DB: filing_status PENDING
      else parse failure or unsupported form
        W->>DB: open_review_task with KSEF_PARSE_FAILED or KSEF_UNSUPPORTED_FORM
      end
    end
    W->>DB: advance the cursor in the same transaction as the last persisted batch
    Note over W,KQ: a truncated package re-enqueues a continue message for the same client and subject type
  end
  W->>K: DELETE /auth/sessions/current, always, in finally
  W->>FQ: one message per PENDING invoice, and per LINKED invoice whose XML is not filed yet: the ksef invoice id only
  FQ->>I: dequeue, as the ingestion identity
  I->>DB: the client id for this invoice id from a definer, then SET LOCAL app.client_id X
  I->>DB: load the ksef_invoices row and its XML under the X scope
  I->>I: link ACTIVE, KSeF service on, permanent storage date inside the backfill window, daily filing cap not reached
  I->>I: re-hash the XML against invoice_hash, re-run the tenant check against the X NIP and roles
  I->>I: category, year and month from the DB row, never from the message
  alt filing_status PENDING
    I->>I: render the PDF in a sandboxed worker thread with the official generator
    I->>SP: PUT KSeF_{number}.pdf and KSeF_{number}.xml by id under the X folderItemId, conflictBehavior fail
    SP-->>I: driveItem ids
    I->>DB: documents row with origin KSEF, ksef_mark_filed, audit_events row
  else filing_status LINKED
    I->>SP: PUT KSeF_{number}.xml by id next to the linked bot upload, conflictBehavior fail
    SP-->>I: driveItem id
    I->>DB: companion_drive_item_id on the linked document, audit_events row
  end
  Note over W,K: 429 waits exactly Retry-After and a repeat opens a breaker. 5xx or 550 retries the same cursor. 401, 403 or 450 marks the link BROKEN
```

## Reading notes

- **Separate identities.** `ksef-sync` reads KSeF tokens from `kv-ksef` and can reach KSeF, but
  it cannot touch SharePoint. Ingestion can write SharePoint but cannot read `kv-ksef`. A
  compromise of one side does not give the other side's capability.
- **Tenant mismatch abandons the whole package.** If any invoice in an export package fails the
  tenant check, nothing from that package is persisted, the cursor does not move, the link is
  marked `BROKEN` and a Sev1 alert fires. No invoice is dropped silently while the rest are kept.
- **Ingestion checks everything again.** The queue message carries only the invoice id, and never
  any PDF bytes. Ingestion finds the client through a definer, loads the XML under that client's
  scope, re-hashes it, re-runs the tenant check, and derives the folder from the database row. It
  also requires an active KSeF link, the KSeF service on the client, a permanent-storage date
  inside the link's backfill window, and a per-client daily filing cap. It renders the PDF itself.
  The name of the definer that maps an invoice id to its client is not fixed yet; it plays the
  same role as `decision_client` does for review decisions.
- **A linked invoice still gets its XML.** When a bot upload matched, ingestion files only
  `KSeF_{number}.xml` next to it and records it as the document's companion file.
- **Matching stays inside one client (I11).** The same invoice between two BCR clients becomes two
  rows, one for each client, keyed on `(client_id, ksef_number)`. Only the QR hash sets
  `ksef_verified`. A business-key match is accepted only when exactly one document matches.
- **The cursor moves only after the data is persisted.** Filing to SharePoint happens afterwards,
  so a SharePoint failure never blocks the cursor. If filing gets a 409, ingestion compares
  hashes: the same file is `ALREADY_FILED`, a different file opens a `KSEF_FILE_CONFLICT` review
  task.
- **Zero LLM tokens** on this path. The XML is parsed deterministically.
