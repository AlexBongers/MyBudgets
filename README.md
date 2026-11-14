# MyBudgets

Persoonlijke budget-app voor **macOS** (Electron): Rabobank-transacties importeren, automatisch categoriseren,
budgetteren en inzicht krijgen. Alles draait lokaal; je gegevens verlaten je Mac nooit.

## Starten (op je Mac)

Vereist [Node.js](https://nodejs.org) ≥ 22.13 (aanbevolen: LTS).

```bash
npm install
npm start          # opent de app
npm test           # parser, categoriseermodule, corpus, service, server (77 tests)
npm run e2e        # doorloopt de echte app (18 controles, tijdelijke database)
npm run e2e:mobile # browserversie op 7 schermformaten (telefoon t/m foldable)
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

### Importeren uit Actual Budget

Bestand → **Importeren uit Actual Budget…** (of sleep de ZIP/`db.sqlite` in het venster). Exporteer in Actual via je budgetnaam → Settings → *Export data*.
De importer (`src/actual.js` + `src/importer.js`) leest de `db.sqlite` uit die ZIP (alleen-lezen) en neemt over: transacties (datum, bedrag, tegenpartij, ruwe banktekst, notities),
categorieën mét groepen en inkomen/uitgave, rekeningen, overboekingen (transfer-payees), splitsingen en het maandbudget (tracking of envelope).
Je ziet eerst een **voorbeeld** en koppelt Actual-rekeningen aan bestaande of nieuwe rekeningen (met optioneel je echte IBAN) en Actual-categorieën aan die van MyBudgets (herkend op naam en synoniemen, NL/EN) of nieuwe.
Er wordt pas geschreven na “Importeren”; de app leert van elke meegebrachte indeling.

- Staan dezelfde transacties al in MyBudgets (bijv. uit je Rabobank-import; zelfde bedrag, datum ±3 dagen), dan worden ze **verrijkt** met je Actual-categorie in plaats van dubbel te worden.
- Importeer je later een **Rabobank-CSV** voor dezelfde rekening (zelfde IBAN), dan sluiten de transacties erop aan (zelfde datum en bedrag): ze krijgen volgnummer, saldo en tegenrekening van de bank en houden hun categorie.
- Opnieuw importeren voegt niets dubbel toe; elke import staat in de importgeschiedenis en is terug te draaien. Een voorbeeldexport staat in `samples/actual-demo.zip` (gegenereerd met `samples/make-actual-demo.js`).

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
| **Jaaroverzicht** | een heel jaar in één scherm: kerncijfers met vergelijking met vorig jaar (zelfde periode), maandgrafiek, inkomsten per bron, uitgaven per categorie met verloop, top tegenpartijen en grootste uitgaven |
| **Inzichten** | patronen die de app zelf vindt in al je transacties: seizoenen, verschuivingen, gewoontes, vaste lasten in beweging, eenmalige uitgaven, contant geld, achteraf betalen, retouren, weekritme, verwachting voor dit jaar |
| **Categorieën & regels** | categorieën (samenvoegen bij verwijderen), regels met live voorbeeld, regelsuggesties, geheugen |
| **Overzicht** | drill-down per categorie of tegenpartij (klik op een categorie of tegenpartij) |
| **Instellingen** | thema, rekeningen, back-up/herstel, CSV-export, importgeschiedenis |

Verder: opdrachtpalet **⌘K**, meerdere rekeningen, donker/licht, native menu, onthoudt scherm, maand en venster.

Sneltoetsen: ⌘O importeren · ⌘K zoeken/navigeren · ⌘1–9 schermen · ⌘[ ⌘] vorige/volgende maand · ⌘Z ongedaan maken · ⇧⌘E exporteren.

## Als server draaien (Proxmox / Docker) — voor meerdere gebruikers

Dezelfde app draait ook als webserver op je thuisnetwerk: jij en je partner openen hem in de browser op bijv.
`http://192.168.1.50:3000` en zien altijd dezelfde, actuele gegevens (één database op de server). Geen npm-dependencies nodig; alleen Node ≥ 22.13 of Docker.

**Docker (op een VM of LXC met Docker in Proxmox):**

```bash
git clone https://github.com/AlexBongers/MyBudgets && cd MyBudgets
cp .env.example .env        # zet in .env een lang wachtwoord
docker compose up -d --build
```

**Zonder Docker (bijv. in een LXC met Node):**

```bash
HOST=0.0.0.0 PORT=3000 MYBUDGETS_PASSWORD='lang-wachtwoord' DB_PATH=/var/lib/mybudgets/budget.db node src/server.js
```

(Maak er een systemd-service van met `Restart=always` voor opstarten bij boot.)

- Inloggen: de browser vraagt om een wachtwoord (gebruikersnaam mag leeg of iets zijn). Zonder `MYBUDGETS_PASSWORD` weigert de server te starten zodra `HOST` niet localhost is.
- Gegevens: `data/budget.db`; elke dag een back-up in `data/backups` (14 bewaard). Zet `data/` in je Proxmox-back-upschema. In Instellingen kun je een back-up downloaden én herstellen (de server start daarna zelf opnieuw; dat werkt door `restart: unless-stopped` in het compose-bestand).
- **Je bestaande gegevens meenemen:** maak op je Mac een back-up (Instellingen → Back-up maken), zet het bestand als `data/budget.db` op de server (server eerst stoppen) en start opnieuw.
- Samen tegelijk werken kan; SQLite is hier ruim snel genoeg voor twee gebruikers. Verander je dezelfde transactie tegelijk, dan wint de laatste.
- Zet de server niet rechtstreeks op internet. Wil je buitenshuis erbij: gebruik een VPN (WireGuard/Tailscale) of een reverse proxy met HTTPS (bij HTTP gaat het wachtwoord leesbaar over het netwerk).
- **Op je telefoon of foldable:** open het adres in Safari/Chrome en kies *Zet op beginscherm*. Telefoon: tabbalk onderin met *Meer*; uitgevouwen foldable/tablet: smalle zijrail; uit-/dichtvouwen past de indeling direct aan. Kom je na een tijdje terug in de app, dan ververst hij vanzelf.
- In de browser ontbreken de Mac-specifieke functies (menu, PDF-export via ⌘P, native bestandsdialogen); importeren (Rabobank-CSV, Actual-ZIP) werkt via bestanden kiezen of slepen. Gebruik Ctrl+P → "Opslaan als pdf" van de browser.

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
src/        rabobank (parser), normalize, merchants, categorizer, db (schema/migraties/schrijven), reports (leesmodel),
            service (API-routes), recurring, actual + importer + zip (Actual-import), util (gedeelde helpers), server (dev)
renderer/   interface (vanilla JS/SVG, geen dependencies; lettertype Geist lokaal in renderer/fonts, SIL OFL)
samples/    generate.js en rabobank-demo.csv (fictieve data)
scripts/    bench.js
test/       node:test
```

Data: `~/Library/Application Support/MyBudgets/budget.db` (SQLite). Back-ups maak je via Instellingen of het menu Bestand.
