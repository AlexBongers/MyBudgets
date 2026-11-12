# Changelog

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

**Intern**
- Rabobank-parser overgenomen uit `actual-budget-mcp`; ruwe bytes worden doorgegeven voor betrouwbare coderingsdetectie.
- Prestaties op 60.000 transacties: één transactie indelen 1,5 s → 60 ms, dashboard 320 → 180 ms.
- CI-workflow (tests op Node 22 en 24), 42 tests.

## 2.0.0
- Eerste native macOS-versie (Electron): import, categoriseermodule, budget, dashboard.
