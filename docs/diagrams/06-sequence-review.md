# D6: Manual review

**Status: TARGET.** Review in the staff app "BCR Weryfikacja", with notifications in the
"Weryfikacja dokumentów" channel. None of it is built yet.

The review app holds **no SharePoint permission**. It records the decision and puts the decision
id on the `review-commands` queue. Ingestion, the only SharePoint writer, moves the file by id
inside the same client's drive. Boxes follow the [README](README.md#trust-boundaries).

```mermaid
sequenceDiagram
  autonumber
  actor ACC as Accountant
  box rgb(220,252,231) BCR staff surfaces
    participant CH as Weryfikacja dokumentów channel
    participant TAB as BCR Weryfikacja staff app
  end
  box rgb(241,245,249) Ledger Azure
    participant R as review-api, no Graph permission
    participant DB as PostgreSQL with RLS
    participant Q as review-commands queue
    participant I as ingestion, the only SharePoint writer
  end
  participant E as Entra ID
  box rgb(219,234,254) Client X Team site
    participant SP as Graph and SharePoint
  end

  Note over DB: open_review_task wrote the task and a notification_outbox row in one transaction, see D5
  R->>DB: claim_outbox returns task ids only, marker written before the side effect
  R->>CH: Workflows webhook card: task number, reason label, due date, staff names, deep link to the task. No client name, no filename
  R->>DB: ack_outbox
  ACC->>CH: opens the card
  CH->>TAB: the deep link opens the task
  TAB->>TAB: Teams SSO, getAuthToken
  TAB->>R: GET /api/review/tasks/{taskId} with the SSO token
  R->>E: verify signature, issuer, tenant and audience against JWKS
  R->>R: require role Ledger.Reviewer and a upn claim. Guests and app-only tokens are refused
  R->>DB: SET LOCAL ROLE ledger_reviewer, app.staff_oid and app.staff_upn, then SELECT the task and document
  Note over DB: RLS: the client must be among the reviewer's active staff_assignments, and the staff_members row must be active
  alt not assigned, or unknown id
    DB-->>R: 0 rows
    R-->>TAB: 404, the same as for an unknown id, so there is no existence oracle
  else assigned
    DB-->>R: suggestion kept below 0.70, fields, webUrl, version
    R-->>TAB: task view with a link, never the bytes
    ACC->>SP: opens webUrl with their own sign-in. Team membership mirrors the assignment
    ACC->>TAB: Zatwierdź i przenieś, with category, year, month, direction and field fixes
    TAB->>R: POST the decision with If-Match version
    R->>R: validate with reviewDecisionSchema, built from folderTaxonomy. 98_Nieposortowane excluded, dated categories need year and month
    R->>DB: review_decide as ledger_review_fn: append-only review_decisions row with the upn, task APPLYING
    R->>Q: the decision id only
    R-->>TAB: accepted, applying
    Q->>I: dequeue the decision id, as the ingestion identity
    I->>DB: decision_client(decision id) returns the client id only, then SET LOCAL app.client_id X
    I->>DB: load the decision, document and storage target under RLS. Already applied means no-op
    I->>I: assert the document drive_id equals the X target drive_id and the item still lies under folderItemId
    I->>SP: ensure the target folder chain by id under folderItemId
    I->>SP: PATCH /drives/{driveId}/items/{itemId} with the new parentReference, conflictBehavior fail
    SP-->>I: moved item, parentReference.driveId asserted equal to the X drive
    I->>DB: documents REVIEWED with fields, folder_path and current_decision_id, outcome APPLIED, task RESOLVED, learning.label as definer, audit_events row
  end
  Note over R,I: applyRetrySweep in review-api is the only component that re-sends a decision stuck in APPLYING. A 404 on the item gives FILE_MISSING and the task is CANCELLED
```

## Reading notes

- **Ids only.** The channel card and the queue message carry ids and codes. They carry no client
  name, filename or NIP (I7).
- **Scope comes from the token.** The reviewer's oid and upn come from the verified SSO token and
  are set per transaction. Row-level security then shows only clients the reviewer is actively
  assigned to. An unassigned or unknown task gives the same 404.
- **The move stays inside one drive.** Ingestion takes the client from the decision, not from any
  message field, and checks that the file and the target folder are in that client's drive and
  under its channel folder before it sends the PATCH. Moving by item id also survives the client
  renaming the file while it waits in `98_Nieposortowane`.
- **Odrzuć** (reject) and **To duplikat** (duplicate) move nothing. The document becomes
  `REJECTED` or `DUPLICATE` and the file stays where it is.
- **Quarantine bind** is visible only to triage staff. A bind makes ingestion create a new document
  row in the chosen client and run the normal pipeline for it. The quarantine row has no
  `client_id` to change.
- **Learning.** The decision becomes a label for the same client only. The next classification for
  client X reads only client X's memory (I11).
