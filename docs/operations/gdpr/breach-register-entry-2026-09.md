# Breach register entry: IR-2026-09 (template)

> ⚠️ **DRAFT — the IOD or lawyer must confirm it before it goes into the register.**

GDPR Art. 33(5) requires BCR to document every personal data breach: the facts, its effects
and the remedial action taken. The record must also show why BCR did or did not notify. This
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
| **Okresy narażenia** (exposure windows) | W1, biblioteka BCR GROUP: od {{DATA}} do {{DATA_BLOKADY_FOLDERÓW}}. W2, zespół BCR GROUP publiczny: od {{DATA}} do {{DATA_ZMIANY_NA_PRYWATNY}}. W3, konta `{NIP}@` z możliwością logowania: od {{DATA}} do {{DATA_BLOKADY}}. W4, przenoszenie według NIP z treści: od {{DATA}} do {{DATA_WDROŻENIA_POPRAWKI}}. W5, zakładka „Moje dokumenty”: od {{DATA}} do {{DATA}}. W6, dane w telemetrii: od {{DATA}} do {{DATA}}. W7, zespół Bricore publiczny: od {{DATA}} do {{DATA}}. |
| **Kategorie osób** (data subjects) | {{np. kontrahenci klientów będący osobami fizycznymi (w tym przedsiębiorcy jednoosobowi), pracownicy i współpracownicy klientów, właściciele i wspólnicy klientów}} |
| **Kategorie danych** (data categories) | {{np. dane identyfikacyjne i adresowe, NIP, numery rachunków bankowych, dane o transakcjach, dane o wynagrodzeniu, numery PESEL}} |
| **Skala** (scale) | Zob. tabela „Klienci, których dotyczy naruszenie” poniżej. Łącznie: {{LICZBA_DOKUMENTÓW}} dokumentów, {{LICZBA_OSÓB albo „w trakcie ustalania”}} osób. |
| **Kto miał lub mógł mieć dostęp** (who could access) | W1: członkowie zespołu BCR GROUP (trzy konta: dwóch pracowników BCR oraz konto `AuthoriseMe@`, zob. T-7). W2: każde konto wewnętrzne dzierżawy, w tym trzy konta `{NIP}@` klientów. W4: członkowie zespołu klienta docelowego, w tym jego gość. |
| **Stwierdzony dostęp** (access found) | {{WYNIK_ANALIZY_PURVIEW — np. „brak zdarzeń otwarcia, podglądu ani pobrania przez tożsamość spoza personelu BCR i tożsamości aplikacji”}}. Brak dzienników logowania (dzierżawa bez Entra ID P1). Dziennik audytu obejmuje okres od {{DATA}}. |
| **Możliwe konsekwencje** (likely consequences) | {{OPIS}} |
| **Zastosowane środki** (measures taken) | {{DATA}}: wstrzymano automatyczne wdrożenia (G0). {{DATA}}: zabezpieczono dowody w niemodyfikowalnym magazynie (IR-0). {{DATA}}: zablokowano logowanie na konta `{NIP}@`, a skrzynki przekształcono we współdzielone (T-1, T-2). {{DATA}}: potwierdzono, że zespół BCR GROUP jest prywatny (T-3). {{DATA}}: foldery w bibliotece BCR GROUP dostępne tylko dla właścicieli (T-4). {{DATA}}: lista „Client Directory” z unikalnymi uprawnieniami i wersjonowaniem (T-5). {{DATA}}: wdrożono poprawkę Phase 0: przypisanie wyłącznie na podstawie tożsamości, kwarantanna zamiast wspólnego miejsca, usunięcie zakładki (P0-1 … P0-9). |
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
| **Administratorzy, art. 33 ust. 2** (controllers) | Powiadomienie każdego klienta, którego dokumenty były w W1 lub W4, etapami (art. 33 ust. 4). | BCR jest podmiotem przetwarzającym; decyzję o zgłoszeniu do UODO podejmuje administrator. | zob. tabela klientów |
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
