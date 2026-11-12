# Changelog

## 2.6.0
- **Servermodus** (Docker/Proxmox): `HOST`/`PORT`/`MYBUDGETS_PASSWORD`, wachtwoordbeveiliging (HTTP Basic), dagelijkse back-ups, back-up downloaden, Dockerfile en compose-bestand. Meerdere gebruikers zien dezelfde gegevens.
- Windows-build (installer en portable `.exe`) via GitHub Actions.

## 2.5.0
- **Jaaroverzicht**: kerncijfers, maandgrafiek, inkomsten per bron, uitgaven per categorie met verloop door het jaar, top tegenpartijen en grootste uitgaven. Vergelijkt alleen met vorig jaar als dat vanaf januari data heeft, en dan over dezelfde periode.

## 2.4.0
- **Actual Budget-importer** (export-ZIP of `db.sqlite`): transacties, categorieën met groepen, rekeningen, overboekingen, splitsingen en budgetten (tracking/envelope), met voorbeeld vooraf, rekening- en categoriekoppeling, verrijken van bestaande transacties en leren van je indelingen.
- Een latere Rabobank-CSV voor dezelfde rekening sluit aan op geïmporteerde transacties in plaats van dubbel te worden.
- Notion-importer verwijderd (API-koppeling, token-opslag, CSV/ZIP-lezen).
- Budgetregels voor categorieën zonder transacties maken de categorie aan.

## 2.1.0

**Categoriseren**
- Terugkerend maandelijks inkomen wordt als salaris voorgesteld; betalingen via Mollie/Adyen/PayPal e.d. gebruiken de uiteindelijke partij.
- Tegengestelde bedragen op twee eigen rekeningen worden als overboeking gekoppeld.
- Dubbelzinnige merknamen ("Plus", "Spar", "Coop"…) zijn alleen zeker bij pin-, iDEAL- of incassobetalingen; voornaam-merken verwijderd.
- Gelabeld testcorpus (101 regels) en statistiek over hoe jouw transacties zijn ingedeeld.
- Regelsuggesties op basis van je eigen keuzes; ongedaan maken (⌘Z) herstelt ook het geleerde geheugen.

**Nieuw**
- Opdrachtpalet (⌘K), drill-down per categorie en tegenpartij, transacties splitsen over categorieën.
- Dashboard: saldo-verloop, binnenkort verwachte vaste lasten, spaardoelen.
- Budget: overdragen (rollover) per categorie.
- Importgeschiedenis met terugdraaien; categorieën samenvoegen bij verwijderen.
- Review-flow met toetsenbord (`j`/`k`/`Enter`/`c`/`r`), datumbereik-filter, `/` om te zoeken.
- PDF-export van het huidige scherm (⌘P), thema (systeem/licht/donker).
- Dagelijkse automatische back-ups (14 bewaard), veilig herstel met validatie en veiligheidskopie.

**Beveiliging en robuustheid**
- Browsermodus beschermd tegen DNS-rebinding en CSRF; importfouten noemen de gevonden kolommen; foutief herkende vaste lasten zijn weg te zetten.
- Toegankelijkheid: focusbeheer in dialogen, aria-labels, tooltips op grafieken.

**Intern**
- Rabobank-parser overgenomen uit `actual-budget-mcp`; ruwe bytes worden doorgegeven voor betrouwbare coderingsdetectie.
- Prestaties op 60.000 transacties: één transactie indelen 1,5 s → 60 ms, dashboard 320 → 180 ms.
- CI-workflow (tests op Node 22 en 24), 42 tests.

## 2.0.0
- Eerste native macOS-versie (Electron): import, categoriseermodule, budget, dashboard.
