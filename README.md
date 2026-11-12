# MyBudgets

Persoonlijke budget-app voor **macOS** (Electron): Rabobank-transacties importeren, automatisch categoriseren,
budgetteren en inzicht krijgen. Alles draait lokaal; je gegevens verlaten je Mac nooit.

## Starten (op je Mac)

Vereist [Node.js](https://nodejs.org) ≥ 22.13 (aanbevolen: LTS).

```bash
npm install
npm start          # opent de app
npm test           # parser, categoriseermodule, corpus, service, server (63 tests)
npm run e2e        # doorloopt de echte app (17 controles, tijdelijke database)
npm run dist       # bouwt dist/MyBudgets-*.dmg (Apple Silicon + Intel)
```

De `.dmg` is niet ondertekend. Bij het eerste openen: rechtsklik op de app → **Open** (of
`xattr -cr /Applications/MyBudgets.app`). Via GitHub Actions (`Build macOS app`, handmatig te starten) kun je de
`.dmg` ook laten bouwen zonder lokaal Node te installeren.

Zonder Electron kun je de interface ook in de browser proberen: `npm run web` → http://localhost:3000.

## Importeren

Rabo Internetbankieren → je rekening → **Transacties** → **Downloaden** → formaat **CSV** (kommagescheiden).
Sleep het bestand in het venster of gebruik **⌘O**. Dubbele transacties worden overgeslagen, overlappende
periodes zijn dus geen probleem. Importeer ook je spaarrekening: dan worden overboekingen tussen je eigen
rekeningen herkend en tellen ze niet mee als uitgave. Elke import staat in de **importgeschiedenis**
(Instellingen) en is met één klik terug te draaien.

### Importeren uit Notion

Bestand → **Importeren uit Notion…** (of sleep een `.zip` in het venster). Exporteer in Notion via ⋯ → Export → *Markdown & CSV* (met subpagina's voor meerdere databases). De importer
(`src/notion.js`) leest de ZIP (ook geneste ZIP's en `_all.csv`), herkent per tabel of het transacties of budgetten zijn, raadt de kolommen op naam én op waarden, en begrijpt
NL- en EN-datums (“12 november 2026”, “November 12, 2026 → …”), bedragen (`€1.234,56`, `-€1,234.50`, `(12,00)`), relaties met URL's, aparte uitgaven-/inkomstenkolommen en Type-kolommen.
Je ziet altijd eerst een **voorbeeld** en kunt kolommen, tekens, datum- en decimaalnotatie en de **categorie-koppeling** aanpassen. Er wordt pas geschreven na “Importeren”.
Staan dezelfde transacties al in MyBudgets (bijv. uit je Rabobank-import; zelfde bedrag, datum ±3 dagen), dan worden ze **verrijkt** met de Notion-categorie in plaats van dubbel te worden,
en leert de app van elke indeling. Opnieuw importeren voegt niets dubbel toe; elke import is terug te draaien. Een voorbeeldexport staat in `samples/notion-demo.zip`.

**Rechtstreeks via de Notion-API** (zonder export): maak een integratie op notion.so/my-integrations, deel je database(s) ermee (⋯ → Connections), plak het token in de wizard en kies je databases
(`src/notion-api.js`; dezelfde REST-API als `notion-sdk-js`, zonder dependency). Ondersteund: paginering, rate-limit-retry, alle eigenschapstypen (titel, getal, datum, select, status, formule, rollup, relatie → paginatitel…).
Het token kan versleuteld in de macOS-Sleutelhanger worden onthouden (`safeStorage`).

### Parser

`src/rabobank.js` is overgenomen uit je eigen repo `actual-budget-mcp` (`src/rabobank.ts`) en getest met dezelfde
regressietests (`test/rabobank.test.js`). Hij detecteert scheidingsteken en codering (UTF-8, BOM, ISO-8859-1), repareert
kapotte aanhalingstekens (met regelnummers), kent Nederlandse en Engelse kolomnamen, parseert bedragen en datums strikt,
importeert alleen EUR en toont overgeslagen regels en reparaties na de import. Toegevoegd t.o.v. het origineel: saldo
(`Saldo na trn`), volgnummer en het oude formaat zonder kopregel. Dubbelen worden gedetecteerd met de sleutel
rekening + volgnummer + datum + bedrag.

## Categoriseermodule (`src/categorizer.js`)

Een transactie loopt langs zes lagen; de eerste die iets herkent wint, en elk resultaat heeft een zekerheid en uitleg
("Waarom?" in het detailscherm). Onder 80% komt een transactie in **Te beoordelen**.

1. **Eigen regels**: tegenpartij / omschrijving / IBAN, bevat · is · begint met · regex, bedrag, richting, prioriteit.
2. **Eigen rekeningen**: overboeking, ook als tegengestelde bedragen op twee eigen rekeningen binnen 3 dagen staan.
3. **Geheugen**: leert van je handmatige keuzes per tegenpartij (en IBAN); correcties wegen zwaarder.
4. **Woordenboek**: ~600 Nederlandse winkels, energie, verzekeraars, abonnementen, instanties (`src/merchants.js`).
5. **Rabobank-code**: o.a. geldopname.
6. **Leermodel**: Naive Bayes op jouw bevestigde transacties; alleen suggesties.

Rabo-ruis (pasvolgnummer, datums, winkelnummers, plaatsnamen) wordt eerst opgeschoond (`src/normalize.js`),
zodat "ALBERT HEIJN 1234 EINDHOVEN" en "Albert Heijn 5678" dezelfde tegenpartij zijn. Je kunt alles ongedaan maken
(⌘Z); ook het geleerde geheugen wordt dan teruggedraaid.

## Functies

| Scherm | Wat het doet |
| --- | --- |
| **Dashboard** | KPI's, cumulatieve uitgaven met prognose, 12-maandentrend, categorieën, inzichten, budgetvoortgang, saldo-verloop, binnenkort verwachte vaste lasten, spaardoelen |
| **Te beoordelen** | per tegenpartij indelen met toetsenbord (`j`/`k`, `Enter`, `c`, `r`), regel maken, suggesties bevestigen |
| **Transacties** | zoeken (`/`), filteren (categorie, rekening, soort, datumbereik), bulk indelen, notities, splitsen over categorieën |
| **Budget** | per maand, gemiddelde van 3 maanden als hulp, overdragen (rollover) per categorie, beschikbaar bedrag |
| **Vaste lasten** | automatisch herkende abonnementen en terugkerende betalingen (met ✕ weg te zetten) |
| **Rapporten** | categorie × maand (6/12/24 maanden) met spaarquote |
| **Categorieën & regels** | categorieën (samenvoegen bij verwijderen), regels met live voorbeeld, regelsuggesties, geheugen |
| **Overzicht** | drill-down per categorie of tegenpartij (klik op een categorie of tegenpartij) |
| **Instellingen** | thema, rekeningen, back-up/herstel, CSV-export, importgeschiedenis |

Verder: opdrachtpalet **⌘K**, meerdere rekeningen, donker/licht, native menu, onthoudt scherm, maand en venster.

Sneltoetsen: ⌘O importeren · ⌘K zoeken/navigeren · ⌘1–7 schermen · ⌘[ ⌘] vorige/volgende maand · ⌘Z ongedaan maken · ⇧⌘E exporteren.

## Privacy en beveiliging

- Alle gegevens staan lokaal in één SQLite-bestand; er gaat niets het internet op.
- De Electron-app praat met de database via IPC (geen open poort), met `contextIsolation`, `sandbox`, een strikte CSP en geblokkeerde navigatie.
- Herstellen van een back-up valideert het bestand en maakt eerst een veiligheidskopie.
- De optionele browsermodus (`npm run web`) luistert alleen op `127.0.0.1`, controleert de `Host`-header (DNS-rebinding) en accepteert schrijfacties alleen als `application/json` (CSRF).

## Prestaties

`node --no-warnings scripts/bench.js 60000` (60.000 transacties, 3 rekeningen, 5 jaar): import 1,7 s, dashboard
0,18 s (0,1 s herhaald), rapport 12 mnd 30 ms, één transactie indelen 60 ms, alles opnieuw categoriseren 0,55 s.
`MYB_PROFILE=1` toont trage queries.

## Indeling

```
electron/   hoofdproces (venster, menu, IPC, bestandsdialogen) + preload
src/        rabobank (parser), normalize, merchants, categorizer, db (schema/migraties), recurring, service (API), server (dev)
renderer/   interface (vanilla JS/SVG, geen dependencies)
samples/    generate.js en rabobank-demo.csv (fictieve data)
scripts/    bench.js
test/       node:test
```

Data: `~/Library/Application Support/MyBudgets/budget.db` (SQLite). Back-ups maak je via Instellingen of het menu Bestand.
