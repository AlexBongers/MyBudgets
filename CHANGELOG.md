# Changelog

## 2.11.0
- **Frisse, moderne look**: licht koel grijs met witte kaarten en een indigo accent (donker: diep blauwzwart), actieve navigatie als getint vlak, knoppen met een subtiel verloop.
- **Eén lettertype (Geist) voor alles**: het schreeflettertype voor titels en grote bedragen is weg; bedragen staan nu in strakke, goed leesbare cijfers met vaste breedte.

## 2.10.0
- **Inzichten** (nieuw scherm): de app zoekt zelf naar patronen in al je transacties en zet de belangrijkste bevindingen bovenaan, met daaronder de onderbouwing. Onder meer: saldo over twaalf maanden en verwachting voor het lopende jaar, seizoenspatroon (maanden met extra inkomen), verschuivingen per categorie, gewoontes (hoe vaak × hoe duur), vaste lasten die duurder werden, stopten of nieuw zijn, eenmalige grote uitgaven tegenover je gewone maand, contant geld, achteraf betalen, retouren, kleine bedragen, weekritme en betrouwbaarheid van de gegevens.
- Alles wordt live uit je eigen database berekend (`src/insights.js`, `GET /api/insights`); verschillende schrijfwijzen van dezelfde winkel (bijv. met `BCK*` ervoor) worden daarbij samengevoegd.

## 2.9.0
- **Nieuwe look** ("kasboek"): warm papier en inkt met een diepgroen accent, eigen lettertypen (Geist voor de interface, Fraunces voor titels en bedragen; lokaal meegeleverd, OFL-licentie), kerncijfers als één doorlopende strook, rustiger kaarten, knoppen en velden, zwevende tabbalk op de telefoon.
- Grafieken: inkomsten blauw en uitgaven koraal (getoetst op kleurenblindheid, licht en donker), staven met afgeronde top op de basislijn, gestippelde hulplijnen, donut met haarlijnen tussen de segmenten, saldo-verloop met verloop-vulling.
- Categoriekleuren in afgestemde, per groep verwante tinten; bestaande categorieën krijgen de nieuwe kleur alleen als je de standaardkleur nooit had aangepast.
- Kleine dingen: rail toont korte namen, geen toetsenbordmarkering op touch, teksten die naar ⌘O verwezen passen zich aan.

## 2.8.1
- Versienummer zichtbaar: onderin de zijbalk, in Instellingen → Weergave en in de Meer-sheet op de telefoon; ook via `/api/version`.

## 2.8.0
- **Telefoon**: tabbalk onderin (Dashboard, Beoordelen, Transacties, Budget) met *Meer*-sheet voor de rest en het totaalsaldo; dialogen als sheet van onderen; filters inklapbaar; transacties, budget, vaste lasten, categorieën en regels als compacte kaarten.
- **Foldables en tablets**: smalle navigatierail tussen 600 en 1100 px; indeling volgt de werkelijk beschikbare breedte (container queries). Uit- of dichtvouwen tekent het scherm opnieuw. Op apparaten met een fysieke vouw lopen kolommen om het scharnier heen (Viewport Segments).
- **Grafieken** worden op hun echte breedte getekend: leesbare labels op elk scherm.
- **Robuuster**: duidelijke melding met *Opnieuw proberen* als de server even weg is; lezen wordt één keer automatisch herhaald; verouderde antwoorden bij snel wisselen worden genegeerd; terugkeren naar de app na een minuut ververst de gegevens; geen gecachete oude bestanden na een update.
- Touch: geen dubbeltik-zoom, directe tik-feedback, grotere tikdoelen, geen ongevraagd toetsenbord bij het openen van een dialoog.
- `npm run e2e:mobile`: controleert 10 schermen op 7 schermformaten (telefoon, Fold-cover, Flip, uitgevouwen, Pixel Fold, liggend, desktop).

## 2.7.0
- **Mobiele browser**: onderbalk als navigatie, één kolom, transacties als kaarten, bottom-sheet dialogen, toevoegen aan beginscherm (webapp-manifest).
- **Ongebruikte categorieën opruimen** (Categorieën & regels): verwijdert categorieën zonder transacties, regels, geheugen of budget; systeemcategorieën blijven.

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
