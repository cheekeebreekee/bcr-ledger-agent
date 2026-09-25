# D5: Client upload through the bot DM

**Status: TARGET.** The upload path after the Phase-3 queue cutover, with the index database from
Phase 2. None of it is built yet. [00-phase0-routing.md](00-phase0-routing.md) shows what runs
after Phase 0.

Boxes mark whose side a participant is on: blue for Microsoft 365 and the client, grey for the
ledger's own apps, amber for external services, green for staff only. See the
[README](README.md#trust-boundaries).

```mermaid
sequenceDiagram
  autonumber
  actor G as Client guest
  box rgb(219,234,254) Microsoft 365
    participant T as Teams and Bot Service
  end
  box rgb(241,245,249) Ledger Azure
    participant B as teams-bot
    participant ST as stbcrlq staging blobs and queues
    participant W as ingestion worker
    participant DB as PostgreSQL with RLS
  end
  box rgb(254,243,199) External
    participant A as Anthropic API
  end
  box rgb(219,234,254) Client X Team site
    participant SP as Graph and SharePoint
  end
  box rgb(220,252,231) Staff only
    participant QS as Quarantine site
  end

  G->>T: DM with one or more attachments
  T->>B: POST /api/messages with a Bot Framework JWT
  B->>B: gate: personal conversation, BCR tenant, GUID aadObjectId, else one fixed Polish line and stop
  B->>T: download attachments, size cap per file
  B->>ST: write bytes to ingest-staging/{requestId}/{index}, write-only, cannot read or list
  B->>ST: IngestRequestV1 on ingest-requests: requestId, uploader oid and tenant, conversation reference, blob names, sha256
  Note over B,ST: requestId is a uuidv5 of conversationId and activityId, so a Teams redelivery is deduplicated
  B-->>G: Otrzymano N dok.
  ST->>W: dequeue, as the ingestion identity
  W->>DB: resolve_uploader(oid) returns client and staff options with reason codes, ids only
  alt no active binding, revoked, unapproved multi-team guest, staff without assignment
    W->>QS: upload by id, server-made name, conflictBehavior fail
    W->>DB: quarantine_hold writes intake_quarantine, which has no client_id
    W->>ST: ingest-results: quarantined, no URL and no client name
    ST->>B: dequeue result
    B-->>G: card row: original filename and Dokument przekazano do weryfikacji, no link
    Note over W: nothing else happens for this request
  else several options, every one approved
    W->>DB: pending_client_choices: pendingId, uploader oid, option ids, expires in 24 h
    W->>ST: ingest-results: picker with pendingId and the uploader's own options
    ST->>B: dequeue result
    B-->>G: picker card that carries only pendingId
    G->>B: picks client X
    B->>B: gate again, uploader oid taken from this new activity
    B->>ST: ingest-requests: choice with pendingId and clientId
    ST->>W: dequeue choice
    W->>DB: confirm_uploader_choice: same uploader oid, clientId among the options and current bindings
    Note over W,DB: expired or invalid choice goes to quarantine
  else exactly one active binding
    Note over W: client X is that binding
  end
  Note over W,DB: every DB call is a short transaction under SET LOCAL app.client_id X. No transaction spans a Claude or Graph call
  loop each document of client X
    W->>ST: read the staged blob, its name prefix must equal requestId, verify its sha256
    W->>DB: reserve a documents row PENDING, idempotency key, lease
    W->>DB: live row with the same content_sha256? RLS shows client X rows only
    alt duplicate for client X
      Note over W: status DUPLICATE, reply links the existing file, no Claude call
    else new document
      W->>W: read the PDF text layer and QR code, check the KSeF number CRC-8. A filename is never a key
      alt QR hash equals invoice_hash of a synced KSeF invoice of X, or a text-layer KSeF number whose invoice agrees on seller NIP, gross and issue date
        W->>DB: fields from the KSeF XML, no Claude call. Only a QR hash sets ksef_verified
      else classify
        W->>A: claude-opus-5, structured output. Cached prefix without client data, then X context and memory, then the document
        A-->>W: category, confidence, fields, parties, usage
        W->>DB: classification_runs row with tokens, cost and model served
        W->>W: AcceptancePolicy: 0.70 threshold and review reasons such as CLIENT_NOT_PARTY. Content never re-routes
        Note over W: picked from a picker, X NIP absent, another option NIP present: choice_mismatch, quarantine and a reconfirm card
      end
      W->>DB: UPLOADING with a server-made stored_name
      alt accepted
        W->>SP: PUT /drives/{driveId}/items/{folderItemId}:/{taxonomy path}/{stored name}:/content, conflictBehavior fail
      else below 0.70 or any review reason
        W->>SP: PUT under {folderItemId}:/98_Nieposortowane/YYYY/MM/{stored name}, conflictBehavior fail
      end
      SP-->>W: driveItem id and webUrl, parentReference.driveId asserted equal to the X drive
      W->>DB: FILED or NEEDS_REVIEW with fields and parties, open_review_task and notification_outbox in the same transaction
    end
    W->>ST: delete the staged blob, single use
  end
  W->>DB: re-resolve the binding before any link is sent
  W->>ST: IngestResultV1 on ingest-results: ids, Polish labels, webUrl inside client X only
  ST->>B: dequeue result
  B-->>G: one proactive result card
  Note over DB: the review notifier later posts an ids-only card, see D6
```

## Reading notes

- **The bot cannot inject or read an upload.** Its identity can write staging blobs and send on
  `ingest-requests`, and nothing else: it cannot read blobs back, it holds no ingestion role, and
  it has no database write (I6). Ingestion accepts a blob only under the message's own
  `ingest-staging/{requestId}/` prefix, and each blob is used once and then deleted.
- **The picker card carries only a `pendingId`.** The uploader's oid on the choice comes from the
  new activity, never from the card. Ingestion accepts the choice only for the same uploader, and
  only for a client that is still among the options and the uploader's current bindings. An
  expired or invalid choice goes to quarantine.
- **Content never re-routes (I2).** A document whose parties do not include client X gets the
  review reason `CLIENT_NOT_PARTY` inside client X. The only case where content matters is a
  picker choice that contradicts the document (`choice_mismatch`). Even then the file goes to
  quarantine, never to the other client.
- **The KSeF match never uses a filename.** It accepts the QR `invoiceHash`, which alone sets
  `ksef_verified`, or a KSeF number from the PDF text layer that passes the CRC-8 check, but only
  when the invoice also agrees on seller NIP, gross amount and issue date. The business-key match
  (seller NIP, invoice number, gross and date, accepted only when exactly one document matches)
  runs on the KSeF side (see [D7](07-sequence-ksef.md)).
- **Uploads never overwrite (I8).** Names are generated on the server, and the URL is built only
  from the bound client's `driveId` and `folderItemId`.
- **The result card** carries ids, fixed Polish labels and links inside client X only. It
  carries no model text (I7).
