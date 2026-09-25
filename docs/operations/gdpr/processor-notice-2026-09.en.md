# Processor's notice of a personal data breach (phase 1)

> ⚠️ **DRAFT — the IOD or lawyer must confirm it. Do not send before approval.**
>
> **This is the English mirror of [`processor-notice-2026-09.pl.md`](processor-notice-2026-09.pl.md),
> for review.** The Polish version is the one that is sent. Keep the two in step: a change to
> one is made to the other in the same commit.
>
> **How to fill it in (delete this whole box before sending).**
>
> - One notice per client, about that client's documents only. The notice **never** names
>   another client, never lists another client's documents, and never says whose space a
>   document landed in.
> - The `{{…}}` fields are filled from IR-0 and IR-1 (`docs/operations/incident-2026-09.md`). Do
>   not put file names or ids in the notice. The list of documents goes separately, over a
>   secure channel.
> - Choose **Variant A**, **Variant B** or both, and delete what does not apply.
>   - **Variant A:** the client's documents went to the shared BCR GROUP team library (window
>     W1, and W2 while the team was Public).
>   - **Variant B:** the client's document was filed in another BCR client's space (window W4).
> - The client in whose space someone else's document landed does **not** get this notice. Their
>   access to another controller's document is recorded in the breach register.
> - Before sending, check the entrustment agreement (*umowa powierzenia*). It may set a shorter
>   deadline or a required form.
> - The sign-in paragraph in section 4 states only what the IR-0 sign-in exports show (the
>   audit-log sign-in events and the 7-day Entra download, `human-steps.md` H-2). If they have
>   not been read yet, say that the analysis is continuing; never write that no sign-in record
>   exists.

---

| | |
|---|---|
| **From** | {{BCR_FULL_NAME_AND_ADDRESS}}, processor |
| **To** | {{CLIENT_NAME}}, {{CLIENT_ADDRESS}}, controller |
| **Re** | the data processing agreement (*umowa powierzenia*) of {{AGREEMENT_DATE}} |
| **Basis** | GDPR Art. 33(2) and Art. 28(3)(f) |
| **Reference** | IR-2026-09/{{CLIENT_NUMBER}} |
| **Date** | {{DATE_SENT}} |
| **Phase** | 1. We provide the information in phases, as Art. 33(4) GDPR allows. |

Dear Sir or Madam,

as the processor of personal data on your behalf, we are informing you without undue delay of a
personal data breach. It concerns documents you sent us through the "Asystent BCR" assistant in
Microsoft Teams. The investigation is continuing. This notice gives what we know today; further
findings follow by the date in section 7.

## 1. What happened

The assistant receives accounting documents and stores them in your space in our system (your
team in Microsoft Teams, channel "Dokumenty księgowe"). On {{DATE_OF_AWARENESS}} we established
that, because of errors in the assistant's configuration and software, some of your documents
did not reach your space.

**[Variant A]** The documents were stored in the shared document library of the BCR GROUP team,
which is meant for BCR staff. The members of that team, who are BCR staff, had access to it.
During {{PERIOD_TEAM_WAS_PUBLIC}} the team was set to public. During that time any internal
account in our Microsoft 365 organisation could have joined it, including three mailbox
accounts assigned to BCR clients that should not have been able to sign in.

**[Variant B]** {{NUMBER_OF_DOCUMENTS_B}} document(s) were stored in the space of another BCR
client. The assistant assigned a document to a client from a tax number (NIP) that appeared in
its content, regardless of who sent it. As a result, the document may have been accessible to
people representing another business, who are members of that business's team in Microsoft
Teams.

## 2. Period

From {{DATE_FROM}} to {{DATE_TO}}. {{NOTE_ON_PERIOD — e.g. "Access by members of the BCR GROUP team
to these documents was restricted to BCR management on …"}}

## 3. What the breach concerns

| | |
|---|---|
| Types of document | {{DOCUMENT_TYPES — e.g. invoices, bank statements, payroll and HR documents, contracts}} |
| Categories of personal data | {{DATA_CATEGORIES — e.g. names, addresses, tax numbers of sole traders, bank account numbers, salary data, PESEL numbers}} |
| Categories of data subjects | {{SUBJECT_CATEGORIES — e.g. counterparties who are natural persons, employees and contractors, the owner or partners}} |
| Approximate number of documents | {{NUMBER_OF_DOCUMENTS}} |
| Approximate number of people | {{NUMBER_OF_PEOPLE — or: "not yet established; we will give it in phase 2"}} |

## 4. Who had or could have had access

{{RECIPIENTS — Variant A: "BCR staff who are members of the BCR GROUP team; while the team was
public, also any internal account of the organisation". Variant B: "people representing another
business, a BCR client, who are members of its team".}}

**Whether access by unauthorised people was found:** {{ACCESS_FINDINGS — e.g. "The analysis of the
Microsoft 365 file-operation log is continuing; so far we have found no opening or download of
your documents by anyone outside BCR staff." or "We found that on … a document was opened by a
person outside BCR staff."}}

Without the Microsoft Entra ID P1 licence, the Entra sign-in log keeps only 7 days. The
Microsoft 365 audit log records file operations and interactive sign-ins for about 180 days. Our
findings rest on that log, which covers the period from {{AUDIT_LOG_START}}{{SIGN_IN_FINDINGS —
e.g. ", and in that period we found no sign-in to the mailbox accounts assigned to clients"}}. For
any earlier period it cannot be established whether anyone opened a document.

## 5. Likely consequences

{{CONSEQUENCES — e.g. "Disclosure of financial and identifying data to unauthorised people. For
payroll documents holding a PESEL number together with salary data, there is a risk that the
data could be used to impersonate the person concerned."}}

Our preliminary assessment of the risk to the data subjects: {{NO RISK / RISK / HIGH RISK}},
because {{REASONING}}. The final assessment is yours, as controller.

## 6. What we have done and are doing

Done (with dates):

- {{DATE}}: we blocked sign-in on the mailbox accounts assigned to clients, and the BCR GROUP team
  is set to private;
- {{DATE}}: we restricted access to the document folders in the BCR GROUP team library to BCR
  management;
- **[Variant B]** {{DATE}}: we switched off the function that assigned documents to a client from
  their content;
- **[Variant B]** {{DATE}}: we restricted access to the folders in the other client's space where
  your document(s) were stored, so that its members can no longer open them;
- {{DATE}}: we secured the event logs in a store whose contents cannot be changed or deleted,
  readable only by BCR management and the data protection officer;
- {{DATE}}: we stopped automatic deployment of changes to the system.

In progress:

- a software fix after which a document is assigned to a client only from the identity of the
  person who sent it, never from its content. A document that cannot be assigned unambiguously
  goes to a separate review area that no client can reach. {{STATUS — "deployed on …" or "planned
  deployment: …"}};
- moving your documents into your space. Two people approve every move, and earlier versions of
  a file are deleted before it is moved, so that no one else's document ends up in your space.

## 7. Further information

We will send phase 2 by {{PHASE_2_DATE}}. It will contain the results of the file-operation log
analysis and the final number of documents. We will send the list of your documents affected by
the breach separately, over a secure channel: {{CHANNEL — e.g. an encrypted file, with the
password given by phone}}.

## 8. Decisions that are yours as controller

- whether to notify the President of the Personal Data Protection Office, UODO (Art. 33(1) GDPR;
  the 72 hours run from when the controller becomes aware of the breach);
- whether to inform the data subjects (Art. 34 GDPR). That applies where the breach is likely to
  result in a high risk to their rights and freedoms.

We will provide all the information and help you need for these decisions and for any
notification. Please confirm that you have received this notice.

## 9. Contact

| | |
|---|---|
| Data protection officer | {{IOD_NAME}}, {{IOD_EMAIL}}, {{IOD_PHONE}} |
| Responsible person at BCR | {{NAME}}, {{ROLE}}, {{EMAIL}}, {{PHONE}} |

Yours faithfully,

{{NAME}}, {{ROLE}}
