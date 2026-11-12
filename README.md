# MyBudgets

Persoonlijke budget-app voor **macOS** (Electron): Rabobank-transacties importeren, automatisch categoriseren,
budgetteren en inzicht krijgen. Alles draait lokaal; je gegevens verlaten je Mac nooit.

## Starten (op je Mac)

Vereist [Node.js](https://nodejs.org) ≥ 22.13 (aanbevolen: LTS).

```bash
npm install
npm start          # opent de app
npm test           # tests van parser en categoriseermodule
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
rekeningen herkend en tellen ze niet mee als uitgave.

## Categoriseermodule (`src/categorizer.js`)

Een transactie loopt langs zes lagen; de eerste die iets herkent wint, en elk resultaat heeft een zekerheid en uitleg
("Waarom?" in het detailscherm). Onder 80% komt een transactie in **Te beoordelen**.

1. **Eigen regels**: tegenpartij / omschrijving / IBAN, bevat · is · begint met · regex, bedrag, richting, prioriteit.
2. **Eigen rekeningen**: overboeking.
3. **Geheugen**: leert van je handmatige keuzes per tegenpartij (en IBAN); correcties wegen zwaarder.
4. **Woordenboek**: ~600 Nederlandse winkels, energie, verzekeraars, abonnementen, instanties (`src/merchants.js`).
5. **Rabobank-code**: o.a. geldopname.
6. **Leermodel**: Naive Bayes op jouw bevestigde transacties; alleen suggesties.

Rabo-ruis (pasvolgnummer, datums, winkelnummers, plaatsnamen) wordt eerst opgeschoond (`src/normalize.js`),
zodat "ALBERT HEIJN 1234 EINDHOVEN" en "Albert Heijn 5678" dezelfde tegenpartij zijn.

## Functies

Dashboard (KPI's, cumulatieve uitgaven, 12-maandentrend, categorieën, inzichten, prognose) · Te beoordelen
(per tegenpartij indelen) · Transacties (zoeken, filteren, bulk-indelen, notities) · Budget per maand met gemiddelde
van 3 maanden · Vaste lasten (automatisch herkend) · Rapporten (categorie × maand) · Categorieën & regels ·
meerdere rekeningen · CSV-export · back-up/herstel · donker/licht · native menu en sneltoetsen (⌘1–7, ⌘[ ⌘]).

## Indeling

```
electron/   hoofdproces (venster, menu, IPC, bestandsdialogen) + preload
src/        csv, normalize, merchants, categorizer, db, recurring, service (API), server (dev)
renderer/   interface (vanilla JS/SVG, geen dependencies)
samples/    generate.js en rabobank-demo.csv (fictieve data)
test/       node:test
```

Data: `~/Library/Application Support/MyBudgets/budget.db` (SQLite).
