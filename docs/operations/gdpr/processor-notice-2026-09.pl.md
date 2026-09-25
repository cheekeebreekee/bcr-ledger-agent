# Informacja podmiotu przetwarzającego o naruszeniu ochrony danych osobowych (etap 1)

> ⚠️ **PROJEKT — wymaga zatwierdzenia przez IOD lub prawnika. Nie wysyłać przed
> zatwierdzeniem.**
>
> **Instrukcja wypełnienia (usunąć całą ramkę przed wysłaniem).**
>
> - Jedno powiadomienie na jednego klienta, wyłącznie o jego dokumentach. Pismo **nigdy** nie
>   wymienia innego klienta, nie zawiera listy dokumentów innych klientów i nie wskazuje, w
>   czyjej przestrzeni znalazł się dokument.
> - Pola `{{…}}` uzupełnia się na podstawie IR-0 i IR-1 (plik `docs/operations/incident-2026-09.md`).
>   Nie wpisywać nazw plików ani identyfikatorów do treści pisma. Lista dokumentów idzie
>   osobno, bezpiecznym kanałem.
> - Wybrać **Wariant A**, **Wariant B** albo oba, a niepotrzebny usunąć.
>   - **Wariant A:** dokumenty klienta trafiły do wspólnej biblioteki zespołu BCR GROUP (okno W1,
>     a w okresie publicznym także W2).
>   - **Wariant B:** dokument klienta został zapisany w przestrzeni innego klienta BCR (okno W4).
> - Do klienta, w którego przestrzeni znalazł się cudzy dokument, **tego** pisma się nie wysyła.
>   Sprawę jego dostępu do cudzego dokumentu opisuje rejestr naruszeń.
> - Przed wysłaniem sprawdzić umowę powierzenia: może przewidywać krótszy termin albo
>   określoną formę powiadomienia.
> - Akapit o logowaniach w punkcie 4 podaje tylko to, co wynika z eksportów logowań z IR-0
>   (zdarzenia logowania z dziennika audytu i pobrany 7-dniowy dziennik Entra, `human-steps.md`
>   H-2). Jeśli nie zostały jeszcze przeanalizowane, napisać, że analiza trwa; nigdy nie pisać,
>   że dzienniki logowania nie istnieją.
> - Wersja angielska do porównania: [`processor-notice-2026-09.en.md`](processor-notice-2026-09.en.md).

---

| | |
|---|---|
| **Od** | {{PEŁNA_NAZWA_I_ADRES_BCR}}, podmiot przetwarzający |
| **Do** | {{NAZWA_KLIENTA}}, {{ADRES_KLIENTA}}, administrator danych |
| **Dotyczy** | umowy powierzenia przetwarzania danych osobowych z dnia {{DATA_UMOWY_POWIERZENIA}} |
| **Podstawa** | art. 33 ust. 2 oraz art. 28 ust. 3 lit. f RODO |
| **Znak sprawy** | IR-2026-09/{{NUMER_KLIENTA}} |
| **Data** | {{DATA_WYSŁANIA}} |
| **Etap** | 1. Informacje przekazujemy etapami, zgodnie z art. 33 ust. 4 RODO. |

Szanowni Państwo,

jako podmiot przetwarzający dane osobowe w Państwa imieniu informujemy bez zbędnej zwłoki o
naruszeniu ochrony danych osobowych. Dotyczy ono dokumentów, które przekazali nam Państwo za
pośrednictwem asystenta „Asystent BCR” w aplikacji Microsoft Teams. Wyjaśnianie sprawy trwa.
Przekazujemy to, co wiemy dziś, a kolejne ustalenia prześlemy w terminie podanym w punkcie 7.

## 1. Co się stało

Asystent przyjmuje dokumenty księgowe i zapisuje je w Państwa przestrzeni w naszym systemie
(Państwa zespół w Microsoft Teams, kanał „Dokumenty księgowe”). {{DATA_STWIERDZENIA}}
stwierdziliśmy, że z powodu błędów w konfiguracji i w oprogramowaniu asystenta część Państwa
dokumentów nie trafiła do Państwa przestrzeni.

**[Wariant A]** Dokumenty zostały zapisane we wspólnej bibliotece dokumentów zespołu BCR GROUP,
przeznaczonej dla pracowników BCR. Dostęp do niej mieli członkowie tego zespołu, czyli
pracownicy BCR. W okresie {{OKRES_ZESPÓŁ_PUBLICZNY}} zespół był ustawiony jako publiczny. Mogło
wtedy do niego dołączyć każde konto wewnętrzne w naszej organizacji Microsoft 365, w tym trzy
konta skrzynek pocztowych przypisanych klientom BCR, które nie powinny były mieć możliwości
logowania.

**[Wariant B]** {{LICZBA_DOKUMENTÓW_B}} dokument(y) został(y) zapisany(e) w przestrzeni innego
klienta BCR. Asystent przypisywał dokument do klienta na podstawie numeru NIP występującego w
treści dokumentu, niezależnie od tego, kto go przesłał. W rezultacie dokument mógł być dostępny
dla osób reprezentujących inny podmiot, będących członkami jego zespołu w Microsoft Teams.

## 2. Okres

Od {{DATA_OD}} do {{DATA_DO}}. {{UWAGA_O_OKRESIE — np. „Dostęp członków zespołu BCR GROUP do tych
dokumentów został ograniczony do kierownictwa BCR w dniu …”}}

## 3. Czego dotyczy naruszenie

| | |
|---|---|
| Rodzaje dokumentów | {{RODZAJE_DOKUMENTÓW — np. faktury, wyciągi bankowe, dokumenty kadrowo-płacowe, umowy}} |
| Kategorie danych osobowych | {{KATEGORIE_DANYCH — np. imiona i nazwiska, adresy, NIP osób prowadzących działalność gospodarczą, numery rachunków bankowych, dane o wynagrodzeniu, numery PESEL}} |
| Kategorie osób, których dane dotyczą | {{KATEGORIE_OSÓB — np. kontrahenci będący osobami fizycznymi, pracownicy i współpracownicy, właściciel lub wspólnicy}} |
| Przybliżona liczba dokumentów | {{LICZBA_DOKUMENTÓW}} |
| Przybliżona liczba osób | {{LICZBA_OSÓB — albo: „nie została jeszcze ustalona; podamy ją w etapie 2”}} |

## 4. Kto miał lub mógł mieć dostęp

{{OPIS_ODBIORCÓW — Wariant A: „pracownicy BCR będący członkami zespołu BCR GROUP; w okresie, gdy
zespół był publiczny, także każde konto wewnętrzne organizacji”. Wariant B: „osoby reprezentujące
inny podmiot, klienta BCR, będące członkami jego zespołu”.}}

**Czy stwierdzono dostęp osób nieuprawnionych:** {{USTALENIA_DOSTĘPU — np. „Analiza dziennika
operacji na plikach Microsoft 365 trwa; dotychczas nie stwierdziliśmy otwarcia ani pobrania
Państwa dokumentów przez osobę spoza personelu BCR.” albo „Stwierdziliśmy, że dnia … dokument
został otwarty przez osobę spoza personelu BCR.”}}

Bez licencji Microsoft Entra ID P1 dziennik logowań Entra obejmuje tylko 7 dni. Dziennik audytu
Microsoft 365 rejestruje operacje na plikach i logowania interaktywne przez około 180 dni.
Ustalenia opieramy na tym dzienniku, który obejmuje okres od
{{POCZĄTEK_DZIENNIKA_AUDYTU}}{{USTALENIA_LOGOWAŃ — np. „; w tym okresie nie stwierdziliśmy
logowania na konta skrzynek pocztowych przypisanych klientom”}}. Dla wcześniejszego okresu nie
da się ustalić, czy ktoś otworzył dokument.

## 5. Możliwe konsekwencje

{{OCENA_KONSEKWENCJI — np. „Ujawnienie danych finansowych i identyfikacyjnych osobom
nieuprawnionym. W przypadku dokumentów kadrowo-płacowych zawierających numer PESEL wraz z danymi
o wynagrodzeniu istnieje ryzyko wykorzystania tych danych do podszycia się pod osobę, której
dotyczą.”}}

Nasza wstępna ocena ryzyka dla osób, których dane dotyczą: {{BRAK_RYZYKA / RYZYKO / WYSOKIE
RYZYKO}}, ponieważ {{UZASADNIENIE}}. Ostateczna ocena należy do Państwa jako administratora.

## 6. Co zrobiliśmy i co robimy

Zrobione (z datami):

- {{DATA}}: zablokowaliśmy możliwość logowania na konta skrzynek pocztowych przypisanych klientom,
  a zespół BCR GROUP jest ustawiony jako prywatny;
- {{DATA}}: dostęp do folderów z dokumentami w bibliotece zespołu BCR GROUP ograniczyliśmy do
  kierownictwa BCR;
- **[Wariant B]** {{DATA}}: wyłączyliśmy funkcję, która przypisywała dokumenty do klienta na
  podstawie ich treści;
- **[Wariant B]** {{DATA}}: ograniczyliśmy dostęp do folderów w przestrzeni innego klienta BCR,
  w których zapisano Państwa dokument(y), tak że jego członkowie nie mogą ich już otworzyć;
- {{DATA}}: zabezpieczyliśmy dzienniki zdarzeń w magazynie, którego zawartości nie można zmienić
  ani usunąć, z dostępem ograniczonym do kierownictwa BCR i inspektora ochrony danych;
- {{DATA}}: wstrzymaliśmy automatyczne wdrażanie zmian w systemie.

W toku:

- poprawka oprogramowania, po której dokument jest przypisywany do klienta wyłącznie na podstawie
  tożsamości osoby przesyłającej, a nigdy na podstawie treści dokumentu. Dokument, którego nie da
  się jednoznacznie przypisać, trafia do odrębnego miejsca weryfikacji, niedostępnego dla
  klientów. {{STATUS — „wdrożona dnia …” albo „planowane wdrożenie: …”}};
- przeniesienie Państwa dokumentów do Państwa przestrzeni. Każde przeniesienie zatwierdzają dwie
  osoby, a wcześniejsze wersje pliku są usuwane przed przeniesieniem, aby w Państwa przestrzeni
  nie znalazł się cudzy dokument.

## 7. Dalsze informacje

Etap 2 przekażemy do {{DATA_ETAPU_2}}. Będzie zawierał wyniki analizy dziennika operacji na
plikach i ostateczną liczbę dokumentów. Listę Państwa dokumentów objętych naruszeniem przekażemy
osobno, bezpiecznym kanałem: {{KANAŁ — np. zaszyfrowany plik, hasło przekazane telefonicznie}}.

## 8. Decyzje, które należą do Państwa jako administratora

- czy naruszenie należy zgłosić Prezesowi Urzędu Ochrony Danych Osobowych (art. 33 ust. 1 RODO;
  termin 72 godzin biegnie od stwierdzenia naruszenia przez administratora);
- czy należy zawiadomić osoby, których dane dotyczą (art. 34 RODO). Dotyczy to sytuacji, gdy
  naruszenie może powodować wysokie ryzyko naruszenia ich praw lub wolności.

Udzielimy wszystkich informacji i pomocy potrzebnych do tych decyzji i do ewentualnego
zgłoszenia. Prosimy o potwierdzenie otrzymania tej informacji.

## 9. Kontakt

| | |
|---|---|
| Inspektor ochrony danych | {{IMIĘ_I_NAZWISKO_IOD}}, {{E-MAIL_IOD}}, {{TELEFON_IOD}} |
| Osoba odpowiedzialna po stronie BCR | {{IMIĘ_I_NAZWISKO}}, {{FUNKCJA}}, {{E-MAIL}}, {{TELEFON}} |

Z poważaniem

{{IMIĘ_I_NAZWISKO}}, {{FUNKCJA}}
