# Breach register entry: IR-2026-09 (template)

> ⚠️ **DRAFT — the IOD or lawyer must confirm it before it goes into the register.**

> **Correction, 29 September 2026. Read before filling in; the template below is unchanged.**
>
> - **The T-1/T-2 measure is withdrawn.** Do not enter "zablokowano logowanie na konta `{NIP}@`,
>   a skrzynki przekształcono we współdzielone (T-1, T-2)" under *Zastosowane środki*. The
>   `{NIP}@bcr-group.pl` accounts are the clients' legitimate Teams sign-ins, not mailboxes nobody
>   signs in with (the owner's decision of 28 September 2026). T-1 was done on 26 September and
>   reversed by Roman on 28 September at 17:33Z; T-2 was never run. Both are withdrawn
>   (`tenant-hardening.md`).
> - **W3 and R2 are redefined** (`incident-2026-09.md`, dated corrections). W3 is "client
>   accounts are Members and reach tenant-wide surfaces", bounded by T-3, T-6, T-8, T-9 and
>   `docs/security.md` T22, never by blocking sign-in: under *Okresy narażenia*, W3 has no
>   blocking date. The exposure in R2 and W2 was BCR GROUP being public. A sign-in by a `{NIP}@`
>   account is the client's own; under *Stwierdzony dostęp*, what matters is whether one joined
>   BCR GROUP or opened its files while it was public.
> - **The client is its `{NIP}@` account, not its guest.** *Przyczyny* (R1) and *Kto miał lub
>   mógł mieć dostęp* (W4) name the client's guest as it was understood then. Keep R1 as written
>   (the id onboarding did not write was the guest's); under W4, the receiving client's team
>   members include its `{NIP}@` account as well as its guest. Guests have no capability in the
>   ledger (`incident-2026-09.md`, R1's correction).
> - **The lockout itself** (the three clients 0002, 0003 and 0004 could not sign in to Teams
>   from 26 September 12:18Z to about 17:34Z on 28 September; no document was lost) is an
>   availability event. Whether it needs its own view in this register is the IOD's call, an
>   open question in the incident's status table (`incident-2026-09.md` → *Client lockout,
>   26–28 September (T-1 reversed)*).

GDPR Art. 33(5) requires BCR, as controller, to document breaches of the data it controls (here
the Client Directory and the telemetry). For client documents, where BCR is the processor, the
breach is documented to support the controllers, under Art. 28(3)(f) and the entrustment
agreements. Either way the record gives the facts, the effects and the remedial action taken,
and shows why BCR did or did not notify. This
entry is written into BCR's own breach register today, and updated as IR-0 to IR-3 progress.

Field names are in Polish, the language of the register, with the English meaning in brackets.
The facts that are already known are filled in. `{{…}}` fields come from the evidence.

**What does not go in here:** file names, client names, NIPs, user ids, and any document
content. Clients are referred to by their BCR record number (ClientId) only. The detail stays in
the IR evidence store, and this entry points to it by hash.

---

## Wpis (the entry)

| Pole (field) | Wpis (entry) |
|---|---|
| **Numer wpisu** (entry no.) | {{NR_W_REJESTRZE}}. Sprawa IR-2026-09. |
| **Data i godzina stwierdzenia naruszenia** (awareness) | {{DATA_GODZINA}}. Uzasadnienie: audyt dostępu w dzierżawie Microsoft 365 z 23 września 2026 r. i przegląd kodu z 23–25 września 2026 r. potwierdziły mechanizm. Przyjęto najwcześniejszy moment, w którym BCR z wystarczającą pewnością wiedziało o naruszeniu. |
| **Data wpisu, osoba wpisująca** (entered on, by) | {{DATA}}, {{IMIĘ_I_NAZWISKO}} |
| **Rola BCR** (BCR's role) | **Podmiot przetwarzający** dla dokumentów klientów przetwarzanych na podstawie umów powierzenia. **Administrator** dla danych własnych BCR: danych pracowników, listy „Client Directory” oraz danych telemetrycznych o przesyłanych dokumentach. |
| **Charakter naruszenia** (nature) | Naruszenie poufności. Dokumenty księgowe klientów przesłane przez asystenta „Asystent BCR” (Microsoft Teams) były zapisywane w miejscach dostępnych dla osób, które nie powinny mieć do nich dostępu: (a) we wspólnej bibliotece zespołu BCR GROUP; (b) w przestrzeni innego klienta BCR, wybranej na podstawie numeru NIP występującego w treści dokumentu. |
| **Przyczyny** (causes) | R1: proces wdrożenia klienta nie zapisywał identyfikatora gościa klienta w liście „Client Directory”, więc przesyłki klientów nie były rozpoznawane. R2: nierozpoznane przesyłki trafiały do biblioteki zespołu BCR GROUP, a zespół był przez pewien czas publiczny. R3: dokument był przenoszony do klienta, którego NIP występował w treści. R4: zabezpieczenie przed duplikatami w liście „Client Directory” nie działało przy trzech i więcej wierszach; identyfikator pracownika był przypisany do wiersza klienta. R5: dokumenty zapisywano w katalogu głównym biblioteki zamiast w folderze kanału. R6: inne luki, m.in. zakładka „Moje dokumenty” ujawniająca nazwę klienta dla dowolnego identyfikatora użytkownika. Szczegóły: `docs/operations/incident-2026-09.md`. |
| **Okresy narażenia** (exposure windows) | W1, biblioteka BCR GROUP: od {{DATA}} do {{DATA_BLOKADY_FOLDERÓW — T-4; dla folderu zablokowanego dopiero przy ponownym sprawdzeniu po H-6b: data tego sprawdzenia}}. W2, zespół BCR GROUP publiczny: od {{DATA}} do {{DATA_ZMIANY_NA_PRYWATNY}}. W3, konta `{NIP}@` z możliwością logowania: od {{DATA}} do {{DATA_BLOKADY}}. W4, przenoszenie według NIP z treści: od {{DATA}} do {{DATA_KOŃCA_W4 — późniejsza z dat: blokady folderów w witrynach klientów (T-4b) i wyłączenia klasyfikatora (H-3); dla dokumentu znalezionego poza zablokowanymi folderami: data jego osobnej blokady (T-4b, sprawdzenie po IR-1)}} ({{ZDANIE_O_DOSTĘPIE — „od tej chwili członkowie zespołu klienta docelowego nie mają dostępu do przeniesionych dokumentów” wpisać dopiero wtedy, gdy sprawdzenie z T-4b po IR-1 zostało wykonane dla każdej witryny i nie pozostawiło bez blokady żadnego przeniesionego dokumentu ani jego kopii; do tego czasu: „sprawdzenie dokumentów poza zablokowanymi folderami trwa”}}; nowe przeniesienia wstrzymano {{DATA_WYŁĄCZENIA_KLASYFIKATORA}}, H-3). W5, zakładka „Moje dokumenty”: od {{DATA}} do {{DATA}}. W6, dane w telemetrii: od {{DATA}} do {{DATA}}. W7, zespół Bricore publiczny: od {{DATA}} do {{DATA}}. |
| **Kategorie osób** (data subjects) | {{np. kontrahenci klientów będący osobami fizycznymi (w tym przedsiębiorcy jednoosobowi), pracownicy i współpracownicy klientów, właściciele i wspólnicy klientów}} |
| **Kategorie danych** (data categories) | {{np. dane identyfikacyjne i adresowe, NIP, numery rachunków bankowych, dane o transakcjach, dane o wynagrodzeniu, numery PESEL}} |
| **Skala** (scale) | Zob. tabela „Klienci, których dotyczy naruszenie” poniżej. Łącznie: {{LICZBA_DOKUMENTÓW}} dokumentów, {{LICZBA_OSÓB albo „w trakcie ustalania”}} osób. |
| **Kto miał lub mógł mieć dostęp** (who could access) | W1: członkowie zespołu BCR GROUP (trzy konta: dwóch pracowników BCR oraz konto `AuthoriseMe@`, zob. T-7). W2: każde konto wewnętrzne dzierżawy, w tym trzy konta `{NIP}@` klientów. W4: członkowie zespołu klienta docelowego, w tym jego gość. |
| **Stwierdzony dostęp** (access found) | {{WYNIK_ANALIZY_PURVIEW — np. „brak zdarzeń otwarcia, podglądu ani pobrania przez tożsamość spoza personelu BCR i tożsamości aplikacji”}}. Logowania kont `{NIP}@` i `AuthoriseMe@`: {{WYNIK_ANALIZY_LOGOWAŃ — np. „brak zdarzeń logowania w okresie od … do …”}}. {{RETENCJA_DZIENNIKÓW — wpisać dopiero po potwierdzeniu w dzierżawie okresu przechowywania dziennika audytu (Purview → Audyt) i tego, że eksport z H-2 (`-SignInUpn`) zawiera zdarzenia `UserLoggedIn`/`UserLoginFailed`. Domyślnie według Microsoft: dziennik logowań Entra bez Entra ID P1 ok. 7 dni, dziennik audytu (Audit Standard) ok. 180 dni. Bez potwierdzenia wpisać tylko to, co wynika z eksportów.}} Dziennik audytu obejmuje okres od {{DATA}}. |
| **Możliwe konsekwencje** (likely consequences) | {{OPIS}} |
| **Zastosowane środki** (measures taken) | {{DATA}}: wstrzymano automatyczne wdrożenia (G0). {{DATA}}: zabezpieczono dowody w niemodyfikowalnym magazynie (IR-0). {{DATA}}: zablokowano logowanie na konta `{NIP}@`, a skrzynki przekształcono we współdzielone (T-1, T-2). {{DATA}}: potwierdzono, że zespół BCR GROUP jest prywatny (T-3). {{DATA}}: wyłączono klasyfikator Claude w działającej wersji, co zatrzymało przenoszenie dokumentów według NIP z treści (H-3); nierozpoznane przesyłki kierowane są do odrębnej witryny kwarantanny zamiast do BCR GROUP (H-6b). {{DATA}}: foldery w bibliotece BCR GROUP dostępne tylko dla właścicieli (T-4), ponownie sprawdzone po przekierowaniu nierozpoznanych przesyłek do kwarantanny {{DATA}}. {{DATA}}: foldery księgowe w katalogu głównym bibliotek wszystkich witryn klientów, do których tożsamość aplikacji mogła zapisywać, dostępne tylko dla właścicieli (T-4b). {{DATA}}: przeniesione dokumenty znalezione poza tymi folderami (przesunięte lub skopiowane przez członków zespołu) zablokowane pojedynczo (T-4b, po IR-1). {{DATA}}: lista „Client Directory” z unikalnymi uprawnieniami i wersjonowaniem (T-5). {{DATA}}: wdrożono poprawkę Phase 0: przypisanie wyłącznie na podstawie tożsamości, kwarantanna zamiast wspólnego miejsca, usunięcie zakładki (P0-1 … P0-9). |
| **Planowane środki** (measures planned) | Przeniesienie dokumentów (IR-2) z zatwierdzeniem dwóch osób i usunięciem wcześniejszych wersji. Baza danych powiązań klientów zastępująca listę (faza 1–2). Codzienny niezależny audyt izolacji. Wymiana poświadczeń po ich dostarczeniu przez zarząd (ryzyko zaakceptowane do tego czasu). |

## Ocena ryzyka (risk assessment), per data set

| Zbiór danych (data set) | Rola BCR | Ryzyko (none / risk / high) | Uzasadnienie (reasoning) |
|---|---|---|---|
| Dokumenty klientów w W1 | podmiot przetwarzający | {{…}} | {{…}} |
| Dokumenty klientów w W4 | podmiot przetwarzający | {{…}} | {{…}} |
| Dokumenty kadrowo-płacowe z numerem PESEL (jeśli występują) | podmiot przetwarzający | {{…}} | {{…}} |
| Dane własne BCR (lista „Client Directory”, telemetria) | administrator | {{…}} | {{…}} |

## Klienci, których dotyczy naruszenie (affected clients)

ClientId only. The detail per client is in the IR register (evidence store).

| ClientId | Okno (window) | Dokumenty (documents) | Etap 1 wysłany (phase 1 sent) | Etap 2 wysłany (phase 2 sent) | Potwierdzenie (ack) | Decyzja administratora wobec UODO / art. 34 (controller's decision, if shared) |
|---|---|---|---|---|---|---|
| {{ClientId}} | {{W1/W4}} | {{n}} | {{data}} | {{data}} | {{data}} | {{…}} |

## Powiadomienia (notifications)

| | Decyzja (decision) | Uzasadnienie (reasoning) | Data (date) |
|---|---|---|---|
| **Administratorzy, art. 33 ust. 2** (controllers) | Powiadomienie każdego klienta, którego dokumenty były w W1 lub W4, etapami (art. 28 ust. 3 lit. f RODO i umowa powierzenia; por. art. 33 ust. 4). | BCR jest podmiotem przetwarzającym; decyzję o zgłoszeniu do UODO podejmuje administrator. | zob. tabela klientów |
| **UODO, art. 33 ust. 1** (dane, dla których BCR jest administratorem) | {{ZGŁOSZONO / NIE ZGŁOSZONO}} | Zgłoszenie tylko wtedy, gdy dziennik audytu wykaże dostęp tożsamości spoza personelu BCR do danych osobowych, dla których BCR jest administratorem. {{WYNIK}} | {{DATA}} |
| **Osoby, których dane dotyczą, art. 34** (data subjects) | {{…}} | Przy wysokim ryzyku (np. PESEL wraz z danymi o wynagrodzeniu, dane bankowe) zawiadomienie następuje przez administratora i na jego decyzję; BCR dostarcza potrzebne informacje. | {{DATA}} |

## Dowody (evidence)

| | |
|---|---|
| Magazyn dowodów (evidence store) | {{KONTO_MAGAZYNU/KONTENER}}, tylko do odczytu dla: Roman, IOD, `yahor.simak@bcr-group.pl` |
| Suma kontrolna listy dowodów (`SHA256SUMS`) | {{SHA256}} |
| Retencja (retention until) | {{DATA}}, ustalona przez IOD |
| Rejestr relokacji IR-2 (relocation register), migawka | {{SHA256}} |

## Zatwierdzenie (sign-off)

| | Imię i nazwisko | Data |
|---|---|---|
| Inspektor ochrony danych | {{…}} | {{…}} |
| Zarząd BCR | {{…}} | {{…}} |

## Aktualizacje wpisu (updates to this entry)

| Data | Zmiana (what changed) | Kto (by) |
|---|---|---|
| {{DATA}} | Wpis utworzony (etap 1) | {{…}} |
