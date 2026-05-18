# Cambuur 360 — Copilot werkinstructies

Deze repo bevat een PWA (`index.html`, `app.js`, `style.css`, `sw.js`, `manifest.json`) die nieuws, video's en podcasts rondom SC Cambuur aggregeert.

## Functioneel ontwerp bijwerken (verplicht)

Het functioneel ontwerp staat in [docs/functioneel-ontwerp.md](docs/functioneel-ontwerp.md) en is een **levend document**.

**Na elke functionele wijziging** aan `app.js`, `sw.js`, `manifest.json`, `index.html` of `style.css`:

1. Werk het relevante hoofdstuk in `docs/functioneel-ontwerp.md` bij.
2. Voeg een nieuwe regel **bovenaan** in de changelog-tabel (hoofdstuk 8) toe met:
   `| YYYY-MM-DD | <hoofdstuk> | <korte omschrijving> | <agent of gebruiker> |`
3. Bevestig in je antwoord welk(e) hoofdstuk(ken) je hebt aangepast.

Voor grotere wijzigingen, of als de gebruiker dat expliciet vraagt: delegeer naar de custom agent `Functioneel ontwerp` (zoekwoorden: "functioneel ontwerp", "FO bijwerken", "documenteer feature").

## Stijl

- Hoofdtekst in Nederlands; Engelse technische termen onveranderd (PWA, service worker, fetch, RSS, etc.).
- Houd de bestaande hoofdstuk-structuur aan; pas hoofdstukken aan, voeg niet zomaar nieuwe toplevel-secties toe.
- Wijzig nooit code en FO in dezelfde edit zonder dat ook de changelog wordt bijgewerkt.
