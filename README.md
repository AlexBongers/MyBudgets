# MyBudgets

Eenvoudige, lokale budget-app voor persoonlijk gebruik, geïnspireerd door Actual Budget.
Je data blijft op je eigen computer (SQLite-bestand `data/budget.db`). Geen accounts, geen cloud, geen npm-dependencies.

## Starten

Vereist Node.js ≥ 22.13.

```bash
npm start            # http://localhost:3000
PORT=4000 npm start  # andere poort
npm test             # parser- en importtest
```

## Wat kan het?

- **Rabobank CSV importeren** (kommagescheiden export uit Rabo Internetbankieren); dubbele transacties worden overgeslagen.
- **Automatisch categoriseren** via regels (tekst in tegenpartij/omschrijving). Wijzig je een categorie, dan kun je er direct een regel van maken.
- **Budgetteren** per categorie per maand (een budget geldt tot je het wijzigt).
- **Dashboard**: inkomsten/uitgaven, spaarquote, 12-maandentrend, uitgaven per categorie, budgetvoortgang en top-tegenpartijen.
- Categorie-type *Overboeking* (bv. sparen) telt niet mee in inkomsten/uitgaven.

Een voorbeeldbestand staat in `samples/rabobank-voorbeeld.csv`.
De app luistert alleen op `127.0.0.1`; maak een backup door `data/budget.db` te kopiëren.
