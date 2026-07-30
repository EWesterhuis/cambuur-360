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
- Bronnen worden gefilterd op een whitelist (`ALLOWED_SOURCES`): Leeuwarder Courant, Omrop Fryslân, Voetbalzone, Voetbal International. Cambuur.nl-artikelen komen uitsluitend via de dedicated Worker-endpoint (geen dubbele ophaalmethode via Google News).
- Per artikel: kop, bron-label, relatieve publicatiedatum ("3 uur geleden") en — indien beschikbaar — een afbeelding.
- Google News RSS levert doorgaans geen item-afbeelding mee (`enclosure`/`media:*`/`<img>` ontbreekt), waardoor Google-items vaak zonder afbeelding worden getoond.
- Best-effort fallback: voor een beperkt aantal Google-items zonder afbeelding wordt via de proxy de artikel-HTML opgehaald en `og:image`/`twitter:image` uitgelezen; resultaten worden tijdelijk gecachet.
- Klik op kaart opent originele artikel in nieuw tabblad (`target="_blank" rel="noopener"`).
- Deduplicatie: op genormaliseerde titel (alleen letters/cijfers, eerste 60 tekens). Bij duplicates wint een niet-Google-bron mét afbeelding boven een Google News-mirror zonder beeld, zodat de gebruiker altijd de rijkste versie ziet.
- **Lokaal archief:** artikelen blijven zichtbaar nadat ze uit de RSS-feed zijn verdwenen. Iedere fetch merget verse items met het lokale archief (dedup op link) en bewaart tot `NEWS_ARCHIVE_MAX_ITEMS` items binnen `NEWS_MAX_AGE_DAYS`. Items zonder `pubDate` krijgen een `firstSeen`-timestamp zodat ze correct verouderen. Alleen renderbare velden worden opgeslagen om de localStorage-footprint klein te houden.
- **Stale-while-revalidate:** bij openen wordt het archief direct gerenderd (geen laad-indicator); op de achtergrond wordt fresh data opgehaald en de lijst stil bijgewerkt. Bij een fetch-fout blijft het archief zichtbaar zonder foutmelding.
- **Skeleton-placeholders:** alleen bij een lege eerste bezoek-cache worden shimmer-kaarten getoond in plaats van de tekst-loader. De shimmer respecteert `prefers-reduced-motion`.

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
- Toont statische tekst: `Cambuur 360. Alles rondom Cambuur.`

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
| Leeuwarder Courant | `www.lc.nl/rss` | RSS | Ja |
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
- **Nieuws-archief-Worker:** aparte Cloudflare Worker `cambuur-news-archive.ewoudwesterhuis.workers.dev` met Workers KV binding `CAMBUUR_ARCHIVE`. Draait elke 5 minuten via een cron trigger, haalt alle RSS-bronnen op, filtert op Cambuur-mentions, past dezelfde `ALLOWED_GOOGLE_SOURCES`-whitelist toe als de client (LC, Omrop Fryslân, Voetbalzone, Voetbal International), leest de `<source>`-tag van Google News uit en schoont de " - Bron"-suffix uit de titel. Vervolgens merget hij met het bestaande archief (dedup op link met voorkeur voor schone titels/bronnen, cross-source dedup op titel met voorkeur voor niet-Google + met afbeelding) en schrijft het resultaat als JSON terug in KV. Retentie 90 dagen, cap op 500 items. Endpoint (GET /) levert `{ updatedAt, count, items }` met CORS + 5 min edge-cache. Zo krijgt elke bezoeker — ook op een nieuw device — direct het volledige, actuele archief zonder client-side per-bron fetches.
- **Hosting:** GitHub Pages (zie `CNAME`).

### 4.5 Configuratie
- `PROXY_TIMEOUT_MS = 10000` — request-timeout per externe call.
- `CACHE_DURATION = 30 * 60 * 1000` — 30 min lokale cache + auto-refresh interval.
- `NEWS_MAX_AGE_DAYS = 30` — nieuwsitems ouder dan 30 dagen worden client-side gefilterd.
- `NEWS_ARCHIVE_MAX_ITEMS = 150` — max. aantal items dat lokaal in het nieuws-archief bewaard blijft.
- `NEWS_ARCHIVE_ENDPOINT` — URL van de centrale nieuws-archief-Worker (`cambuur-news-archive.ewoudwesterhuis.workers.dev`).
- **Worker-side** (`worker/news-archive-worker.js`): `NEWS_MAX_AGE_DAYS = 90` en `NEWS_ARCHIVE_MAX_ITEMS = 500` — het centrale archief bewaart bewust langer/meer zodat een gebruiker die weken wegblijft niets mist. Client-side retentie is bewust korter/kleiner om localStorage niet te belasten.

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
- TTL 30 min voor video's en podcasts; bij verlopen cache wordt fresh data geladen, bij netwerk-fout valt de app terug op (eventueel verlopen) cache.
- **Nieuws** gebruikt een stale-while-revalidate-strategie bovenop een merge-on-fetch archief: bij openen wordt de bestaande cache direct gerenderd, ook als de TTL verlopen is. Alleen bij verlopen TTL of expliciete refresh wordt op de achtergrond nieuwe data opgehaald en samengevoegd (dedup op link, cap op `NEWS_ARCHIVE_MAX_ITEMS`). Zo blijven artikelen zichtbaar nadat ze uit de RSS-feeds verdwenen zijn, en is de gepercipieerde laadtijd bij herhaald bezoek nagenoeg 0 ms.
- **Bronvolgorde bij revalidatie**: (1) centrale nieuws-archief-Worker — één snelle request die ~90 dagen aan artikelen dekt en cross-device consistent is; (2) fallback naar per-bron parallel fetches (Google News, Omrop, LC, Cambuur.nl) als het centrale endpoint faalt of leeg is. Zo blijft de app werken als de Worker down is, en heeft de gebruiker geen last van RSS-feeds die tussentijds zijn geleegd.

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
- Loader: `<div class="loader">... laden...</div>` (video's en podcasts).
- Skeleton: `<div class="news-skeleton-card">…</div>` met shimmer-animatie voor de nieuws-tab bij een lege eerste cache; respecteert `prefers-reduced-motion`.
- Error: `<div class="error-message">...</div>` met user-friendly bericht.

---

## 8. Wijzigingshistorie / changelog

| Datum | Hoofdstuk(ken) | Wijziging | Door |
|-------|----------------|-----------|------|
| 2026-07-30 | 2.2, 4.4, 8 | Nieuws-archief-Worker gelijkgetrokken met client-gedrag: `<source>`-tag uit Google News gebruikt als bronlabel, " - Bron"-suffix uit titels verwijderd, `ALLOWED_GOOGLE_SOURCES`-whitelist toegepast (voorkomt obscure Google-bronnen), en cross-source dedup verkiest niet-Google met afbeelding boven Google News zonder beeld. Bestaande vervuilde items worden bij eerstvolgende cron automatisch opgeschoond. | GitHub Copilot |
| 2026-07-29 | 4.4, 4.5, 5.3, 8 | Centrale nieuws-archief-Worker (`worker/news-archive-worker.js` + `wrangler.toml`) toegevoegd: KV-gebaseerd archief, 5 min cron, 90 dagen retentie, 500 items cap. Client (`app.js`) probeert eerst dit endpoint en valt bij fout terug op per-bron fetches, zodat een gebruiker die weken wegblijft niets mist. | GitHub Copilot |
| 2026-07-29 | 2.2, 4.5, 5.3, 8 | Nieuws-archief (dedup op link, max 150 items, 30 dagen) + stale-while-revalidate + skeleton-placeholders toegevoegd; artikelen blijven bewaard nadat ze uit de RSS-feed verdwijnen en de tab laadt direct vanuit cache. | GitHub Copilot |
| 2026-07-29 | 4.1, 8 | LC RSS-endpoint bijgewerkt: `lc.nl/api/feed/rss` gaf 404 na websitevernieuwing; vervangen door de nieuwe brede feed `www.lc.nl/rss` (dekt sport én regio). | GitHub Copilot |
| 2026-05-18 | 2.2, 2.5, 8 | Cambuur.nl verwijderd uit Google News whitelist (voorkomt dubbele ophaalmethode en verkeerde afbeeldingen); jaartal uit footer verwijderd. | GitHub Copilot |
| 2026-05-18 | 2.2, 8 | Best-effort afbeeldingsfallback toegevoegd voor Google RSS-items via `og:image`/`twitter:image` lookup met cache. | GitHub Copilot |
| 2026-05-18 | 2.2, 8 | Bronlabel `Sportclub Cambuur` gelijkgetrokken naar `Cambuur.nl`; Google RSS-afbeeldingsbeperking gedocumenteerd. | GitHub Copilot |
| 2026-05-18 | 2.5, 7, 8 | Copyright-teken verwijderd uit footertekst in app en ontwerpbeschrijving. | GitHub Copilot |
| 2026-05-18 | Alle | Initiële versie functioneel ontwerp gegenereerd op basis van codebase-staat. | Agent `Functioneel ontwerp` |

<!-- Nieuwe entries bovenaan toevoegen. Format: | YYYY-MM-DD | Hoofdstuk | Wijziging | Door | -->
