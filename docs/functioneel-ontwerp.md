# Functioneel Ontwerp — Cambuur 360

> Levend document. Beheerd door de custom agent `Functioneel ontwerp`.
> Laatste update: 2026-05-18

---

## 1. Doel & doelgroep

### 1.1 Doel
Cambuur 360 is een Progressive Web App (PWA) die nieuws, video's en podcasts rondom SC Cambuur op één plek bundelt. Doel: supporters in één oogopslag op de hoogte houden, zonder dat ze meerdere bronnen of apps hoeven te openen.

### 1.2 Doelgroep
- SC Cambuur-supporters (primair).
- Volgers van het Friese voetbal / Keuken Kampioen Divisie (secundair).
- Lokaal nieuwsgeïnteresseerden in Friesland (tertiair).

### 1.3 Scope
- **In scope:** aggregeren en presenteren van publieke bronnen (RSS, YouTube, podcast-feeds).
- **Buiten scope:** redactie/eigen content, gebruikersaccounts, push-notificaties, betalingen.

---

## 2. Functionele beschrijving

De app heeft één hoofdscherm met drie tabbladen: **Nieuws**, **Video's**, **Podcasts**, plus een vaste header met refresh-knop en een footer.

### 2.1 Header & refresh
- Vaste header met titel "Cambuur 360" en subtitel "Alles rondom Cambuur".
- Refresh-knop (rechtsboven) forceert herladen van alle drie de tabbladen tegelijk en negeert de cache. Knop draait visueel tijdens laden (`spinning`-klasse).

### 2.2 Tab — Nieuws
- Toont een gecombineerde, gededuplicereerde nieuwslijst van de afgelopen 30 dagen.
- Bronnen worden parallel opgehaald; één falende bron blokkeert de rest niet.
- Bronnen worden gefilterd op een whitelist (`ALLOWED_SOURCES`): cambuur.nl, Leeuwarder Courant, Omrop Fryslân, Voetbalzone, Voetbal International.
- Bronlabel-normalisatie: items met bronnaam `Sportclub Cambuur` (uit Google News RSS) worden getoond als `Cambuur.nl`.
- Per artikel: kop, bron-label, relatieve publicatiedatum ("3 uur geleden") en — indien beschikbaar — een afbeelding.
- Google News RSS levert doorgaans geen item-afbeelding mee (`enclosure`/`media:*`/`<img>` ontbreekt), waardoor Google-items vaak zonder afbeelding worden getoond.
- Best-effort fallback: voor een beperkt aantal Google-items zonder afbeelding wordt via de proxy de artikel-HTML opgehaald en `og:image`/`twitter:image` uitgelezen; resultaten worden tijdelijk gecachet.
- Klik op kaart opent originele artikel in nieuw tabblad (`target="_blank" rel="noopener"`).
- Deduplicatie: op genormaliseerde titel (alleen letters/cijfers, eerste 60 tekens).

### 2.3 Tab — Video's
- Toont YouTube-video's van twee kanalen, gesorteerd nieuw → oud.
- **SC Cambuur officiële kanaal** via gratis YouTube RSS-feed (geen API-quota).
- **Keuken Kampioen Divisie** kanaal via YouTube Data API v3 Search, gefilterd op `q=Cambuur`.
- Per video: thumbnail (`maxresdefault.jpg` met `hqdefault.jpg` fallback), titel, kanaalnaam, relatieve datum.
- Klik opent video op youtube.com in nieuw tabblad.
- Bij YouTube API-fout (400/401/403) wordt KKD-zoekopdracht voor de huidige sessie gedeactiveerd.

### 2.4 Tab — Podcasts
- Toont afleveringen van twee podcasts, gesorteerd nieuw → oud, max. 10 per podcast.
- Bronnen:
  - **Sportcast** (Omrop Fryslân) — RSS van argyf2.omropfryslan.nl.
  - **Hertenkamp** (Leeuwarder Courant) — RSS van omnycontent.com.
- Per aflevering: badge met podcast-naam, datum, titel, ingebedde HTML5 `<audio>`-speler met `preload="none"`, uitgever-label.
- Afspelen gebeurt binnen de app.

### 2.5 Footer
- Toont tekst met dynamisch huidige jaartal: `<jaar> Cambuur 360. Alles rondom Cambuur.`

---

## 3. Gebruikersinteracties & user stories

| ID | User story |
|----|------------|
| US-01 | Als supporter wil ik bij openen direct het laatste nieuws zien zodat ik snel op de hoogte ben. |
| US-02 | Als supporter wil ik kunnen wisselen tussen nieuws, video's en podcasts via duidelijke tabs. |
| US-03 | Als supporter wil ik de content kunnen verversen met één knop wanneer ik denk dat er nieuws is. |
| US-04 | Als supporter wil ik artikelen kunnen openen op de originele bron voor het volledige verhaal. |
| US-05 | Als supporter wil ik video's kunnen bekijken op YouTube zonder eerst te zoeken. |
| US-06 | Als supporter wil ik podcast-afleveringen direct binnen de app kunnen beluisteren. |
| US-07 | Als supporter wil ik de app kunnen installeren als app op mijn telefoon (PWA). |
| US-08 | Als supporter wil ik bij geen/slechte internetverbinding ten minste de laatst geladen content kunnen zien. |
| US-09 | Als supporter wil ik dat tijdsaanduidingen automatisch verversen zodat "5 min geleden" niet uren oud blijft. |

---

## 4. Externe afhankelijkheden

### 4.1 Nieuws
| Bron | Endpoint | Type | Via proxy? |
|------|----------|------|------------|
| Google News (filter SC Cambuur/Cambuur) | `news.google.com/rss/search?q=...` | RSS | Ja |
| Omrop Fryslân — Sport | `omropfryslan.nl/rss/sport.xml` | RSS | Ja |
| Omrop Fryslân — Nieuws | `omropfryslan.nl/rss/nieuws.xml` | RSS | Ja |
| Leeuwarder Courant | `lc.nl/api/feed/rss` | RSS | Ja |
| Cambuur.nl | Custom Worker endpoint `?endpoint=cambuur-news` | JSON (sitemap-scrape) | Direct |

### 4.2 Video's
| Bron | Endpoint | API-kosten |
|------|----------|------------|
| SC Cambuur YouTube-kanaal | `youtube.com/feeds/videos.xml?channel_id=UCnZJsm8wS5_ZWPRHPINWeEw` | 0 (RSS) |
| Keuken Kampioen Divisie YouTube-kanaal | YouTube Data API v3 Search (`channelId=UCep9Om7XraP4ZEtpmPygSpg`) | 100 units/call |

### 4.3 Podcasts
| Bron | Endpoint |
|------|----------|
| Sportcast (Omrop Fryslân) | `argyf2.omropfryslan.nl/xml/podcast/788619` |
| Hertenkamp (Leeuwarder Courant) | `omnycontent.com/.../podcast.rss` |

### 4.4 Infrastructuur
- **CORS-proxy:** eigen Cloudflare Worker `cambuur-feed-proxy.ewoudwesterhuis.workers.dev` met 100k requests/dag, 10 minuten edge-cache.
- **Hosting:** GitHub Pages (zie `CNAME`).

### 4.5 Configuratie
- `PROXY_TIMEOUT_MS = 10000` — request-timeout per externe call.
- `CACHE_DURATION = 30 * 60 * 1000` — 30 min lokale cache + auto-refresh interval.
- `NEWS_MAX_AGE_DAYS = 30` — nieuwsitems ouder dan 30 dagen worden gefilterd.

---

## 5. PWA & offline gedrag

### 5.1 Manifest (`manifest.json`)
- Naam: "Cambuur 360", short_name idem.
- Display: `standalone` (volledige app-ervaring).
- Orientation: `portrait-primary`.
- Theme/background-color: `#003DA5` (Cambuur-blauw).
- Iconen: SVG 192×192 en 512×512 met `purpose: any maskable`.
- `start_url`: `./index.html`.

### 5.2 Service Worker (`sw.js`)
- Cache-versie: `cambuur-app-v3`.
- **Install:** statische assets (`./`, `index.html`, `style.css`, `app.js`, `manifest.json`) worden voorgecached.
- **Activate:** oude cache-versies worden verwijderd; `clients.claim()` voor directe controle.
- **Fetch-strategie:**
  - Externe origins → niet onderschept, browser handelt af.
  - Eigen origin → **cache-first** met netwerk-fallback en cache-update; offline fallback levert HTTP 503 "Offline".
- `skipWaiting()` na install: nieuwe versie wordt direct actief.

### 5.3 Cache-strategie data (in-app)
- Per tab eigen `localStorage`-cache (`cambuur_news_cache`, `cambuur_videos_cache`, `cambuur_podcasts_cache`).
- TTL 30 min; bij verlopen cache wordt fresh data geladen, bij netwerk-fout valt app terug op (eventueel verlopen) cache.

### 5.4 Auto-refresh
- Elke 30 minuten (`setInterval`) wordt alle content geforceerd herladen.
- Tijdlabels verversen elke 60 seconden.

---

## 6. Niet-functionele eisen

| Categorie | Eis |
|-----------|-----|
| **Performance** | First contentful paint < 2s bij goede 4G. Cache-hits renderen direct. |
| **Mobile-first** | UI is geoptimaliseerd voor portretmodus op telefoons. |
| **Toegankelijkheid** | `aria-label` op refresh-knop, semantische HTML (`<header>`, `<nav>`, `<main>`, `<footer>`, `<time>`), `loading="lazy"` op afbeeldingen. |
| **Robuustheid** | Per-bron failures zijn geïsoleerd (`try/catch` → lege array). Geen enkele bron mag de hele app blokkeren. |
| **Beveiliging** | `escapeHtml` op alle gebruikersinhoud; `rel="noopener"` op externe links; `referrerpolicy="no-referrer"` op afbeeldingen. ⚠️ Zie openstaand punt 8.x over YouTube API-sleutel. |
| **Privacy** | Geen tracking, geen analytics, geen cookies. |
| **Browsercompatibiliteit** | Moderne evergreen browsers (Chrome, Edge, Firefox, Safari) met PWA-support. |
| **Offline** | Statische shell werkt offline; data-tabs tonen laatste cache. |

---

## 7. Schermontwerp (tekstueel)

```
┌───────────────────────────────────────────┐
│  [achtergrondkleur #003DA5]               │
│  Cambuur 360                         (↻)  │  ← header + refresh-knop
│  Alles rondom Cambuur                     │
├───────────────────────────────────────────┤
│  [📰 Nieuws]  [🎥 Video's]  [🎙️ Podcasts] │  ← tabs (actieve = onderstreept)
├───────────────────────────────────────────┤
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ [afbeelding]                        │  │  ← kaartlijst (per tab anders):
│  │ Artikeltitel                        │  │     - Nieuws: news-card
│  │ Bron · 3 uur geleden                │  │     - Video: video-card (thumb)
│  └─────────────────────────────────────┘  │     - Podcast: podcast-card (audio)
│  ┌─────────────────────────────────────┐  │
│  │ ...                                 │  │
│  └─────────────────────────────────────┘  │
│                                           │
├───────────────────────────────────────────┤
│  2026 Cambuur 360. Alles rondom Cambuur  │  ← footer
└───────────────────────────────────────────┘
```

**Kaarttypes:**
- **News-card:** optioneel beeld links/boven, titel (h3), meta-regel met bron + datum.
- **Video-card:** YouTube-thumbnail (16:9), titel, kanaal · datum.
- **Podcast-card:** badge met podcast-naam, datum, titel, HTML5-audio-speler, uitgever-label.

**States:**
- Loader: `<div class="loader">... laden...</div>`.
- Error: `<div class="error-message">...</div>` met user-friendly bericht.

---

## 8. Wijzigingshistorie / changelog

| Datum | Hoofdstuk(ken) | Wijziging | Door |
|-------|----------------|-----------|------|
| 2026-05-18 | 2.2, 8 | Best-effort afbeeldingsfallback toegevoegd voor Google RSS-items via `og:image`/`twitter:image` lookup met cache. | GitHub Copilot |
| 2026-05-18 | 2.2, 8 | Bronlabel `Sportclub Cambuur` gelijkgetrokken naar `Cambuur.nl`; Google RSS-afbeeldingsbeperking gedocumenteerd. | GitHub Copilot |
| 2026-05-18 | 2.5, 7, 8 | Copyright-teken verwijderd uit footertekst in app en ontwerpbeschrijving. | GitHub Copilot |
| 2026-05-18 | Alle | Initiële versie functioneel ontwerp gegenereerd op basis van codebase-staat. | Agent `Functioneel ontwerp` |

<!-- Nieuwe entries bovenaan toevoegen. Format: | YYYY-MM-DD | Hoofdstuk | Wijziging | Door | -->
