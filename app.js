// === SC Cambuur Nieuws App ===

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search?q=%22SC+Cambuur%22+OR+%22Cambuur%22&hl=nl&gl=NL&ceid=NL:nl';
const OMROP_SPORT_RSS = 'https://www.omropfryslan.nl/rss/sport.xml';
const OMROP_NIEUWS_RSS = 'https://www.omropfryslan.nl/rss/nieuws.xml';
const LC_RSS = 'https://lc.nl/api/feed/rss';
// Eigen Cloudflare Worker als CORS-proxy. Stabiel, zonder rate-limits, en
// vervangt alle eerdere publieke proxies + rss2json.
const FEED_PROXY = 'https://cambuur-feed-proxy.ewoudwesterhuis.workers.dev/?url=';
// Dedicated endpoint op de Worker dat sitemap + artikel-pagina's van cambuur.nl
// scrapt en kant-en-klare JSON teruggeeft (titel, datum, beschrijving, beeld).
const CAMBUUR_NEWS_ENDPOINT = 'https://cambuur-feed-proxy.ewoudwesterhuis.workers.dev/?endpoint=cambuur-news';
const PROXY_TIMEOUT_MS = 10000;
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const CAMBUUR_YT_RSS = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCnZJsm8wS5_ZWPRHPINWeEw';
const KKD_CHANNEL_ID = 'UCep9Om7XraP4ZEtpmPygSpg';
const SPORTCAST_RSS = 'https://argyf2.omropfryslan.nl/xml/podcast/788619';
const HERTENKAMP_RSS = 'https://www.omnycontent.com/d/playlist/fdd7ab40-270d-4a1e-a257-acd200da1324/f600bf09-6893-4d4b-8dab-b294013dac6c/c2972966-574c-4ff3-8ca9-b294013db3e7/podcast.rss';
const CACHE_KEY_NEWS = 'cambuur_news_cache';
const CACHE_KEY_VIDEOS = 'cambuur_videos_cache';
const CACHE_KEY_PODCASTS = 'cambuur_podcasts_cache';
const CACHE_KEY_GOOGLE_IMAGE_LOOKUP = 'cambuur_google_image_lookup_cache';
const YOUTUBE_API_KEY = 'AIzaSyDsYe8VstT2pGXedH1O1Q_3pjWfIqVSBPc';
let kkdSearchDisabled = false;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minuten
const GOOGLE_IMAGE_LOOKUP_LIMIT = 6;
const GOOGLE_IMAGE_LOOKUP_CACHE_MAX = 300;

// === Toegestane nieuwsbronnen ===
const ALLOWED_SOURCES = [
    'leeuwarder courant', 'lc.nl',
    'omrop fryslân', 'omrop fryslan', 'omropfryslan.nl',
    'voetbalzone',
    'voetbal international',
];

// === DOM elementen ===
const nieuwsList = document.getElementById('nieuws-list');
const videosList = document.getElementById('videos-list');
const podcastsList = document.getElementById('podcasts-list');
const refreshBtn = document.getElementById('refreshBtn');
const footerText = document.getElementById('footer-text');
const tabs = document.querySelectorAll('.tab');

// === Tabs ===
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
    });
});

// === Refresh ===
refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    Promise.all([loadNieuws(true), loadVideos(true), loadPodcasts(true)])
        .finally(() => refreshBtn.classList.remove('spinning'));
});

// === Feed ophalen via eigen Cloudflare Worker ===
// Stabiel, 100k requests/dag gratis. Geeft de XML/RSS-response rechtstreeks
// terug met de juiste CORS-headers.
async function fetchViaProxy(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
        const response = await fetch(`${FEED_PROXY}${encodeURIComponent(url)}`, {
            signal: controller.signal,
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`Proxy HTTP ${response.status}`);
        }
        const text = await response.text();
        if (!text || !text.trim()) {
            throw new Error('Lege response');
        }
        return text;
    } finally {
        clearTimeout(timeout);
    }
}

// Parseert een RSS-XML string naar een uniforme item-structuur.
function parseRSS(text) {
    const xml = new DOMParser().parseFromString(text, 'text/xml');
    return Array.from(xml.querySelectorAll('item')).map(item => ({
        title: (item.querySelector('title')?.textContent || '').trim(),
        link: item.querySelector('link')?.textContent || '#',
        pubDate: item.querySelector('pubDate')?.textContent || '',
        description: item.querySelector('description')?.textContent || '',
        // content:encoded staat in een namespace; querySelector pakt 'm met de :
        content: item.getElementsByTagNameNS('*', 'encoded')[0]?.textContent || '',
        image: extractImage(item),
    }));
}

// Probeer een afbeelding te vinden bij een RSS-item via diverse conventies:
// 1) <enclosure type="image/..." url="...">
// 2) <media:content url="..."> / <media:thumbnail url="...">
// 3) eerste <img src="..."> in description of content:encoded
function extractImage(item) {
    const enclosures = item.querySelectorAll('enclosure');
    for (const enc of enclosures) {
        const type = enc.getAttribute('type') || '';
        const url = enc.getAttribute('url') || '';
        if (url && type.startsWith('image')) return url;
    }
    const media = item.getElementsByTagNameNS('*', 'content')[0]
        || item.getElementsByTagNameNS('*', 'thumbnail')[0];
    if (media) {
        const url = media.getAttribute('url');
        if (url) return url;
    }
    const haystack = (item.querySelector('description')?.textContent || '')
        + ' '
        + (item.getElementsByTagNameNS('*', 'encoded')[0]?.textContent || '');
    const imgMatch = haystack.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];
    return '';
}

// Filter items op publicatiedatum: laat alleen items van de afgelopen N dagen zien.
const NEWS_MAX_AGE_DAYS = 30;
function isRecent(pubDate, maxDays = NEWS_MAX_AGE_DAYS) {
    if (!pubDate) return true; // geen datum: niet uitsluiten
    const ts = new Date(pubDate).getTime();
    if (isNaN(ts)) return true;
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    return ts >= cutoff;
}

// === Nieuws laden ===
async function loadNieuws(forceRefresh = false) {
    // Check cache
    if (!forceRefresh) {
        const cached = getCache(CACHE_KEY_NEWS);
        if (cached) {
            renderNieuws(cached);
            return;
        }
    }

    nieuwsList.innerHTML = '<div class="loader">Nieuws laden...</div>';

    // Haal alle bronnen parallel op. Per-bron faalt stil (lege array) zodat één
    // kapotte feed niet alles blokkeert.
    const [googleItems, omropSportItems, omropNieuwsItems, cambuurItems, lcItems] = await Promise.all([
        fetchGoogleNews(),
        fetchOmropFryslanSport(),
        fetchOmropFryslanNieuws(),
        fetchCambuurNL(),
        fetchLeeuwarderCourant(),
    ]);

    const allItems = [
        ...googleItems,
        ...omropSportItems,
        ...omropNieuwsItems,
        ...cambuurItems,
        ...lcItems,
    ];

    if (!allItems.length) {
        nieuwsList.innerHTML = '<div class="error-message">Kon nieuws niet laden. Probeer het later opnieuw.</div>';
        const cached = getCache(CACHE_KEY_NEWS);
        if (cached) renderNieuws(cached);
        return;
    }

    // Combineer en deduplicate op basis van genormaliseerde titel
    const seen = new Set();
    const items = allItems
        .filter(item => isRecent(item.pubDate))
        .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
        .filter(item => {
            const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

    setCache(CACHE_KEY_NEWS, items);
    renderNieuws(items);
}

// Google News RSS via eigen proxy. Aggregator van diverse Nederlandse bronnen,
// gefilterd op toegestane bronnen.
async function fetchGoogleNews() {
    try {
        const text = await fetchViaProxy(GOOGLE_NEWS_RSS);
        const items = parseRSS(text);
        // Google News zet de bron in een <source> element binnen elk item.
        const xml = new DOMParser().parseFromString(text, 'text/xml');
        const itemNodes = Array.from(xml.querySelectorAll('item'));
        const filtered = items
            .map((item, i) => ({
                title: cleanTitle(item.title),
                link: item.link,
                pubDate: item.pubDate,
                image: item.image || '',
                source: normalizeNewsSource(
                    itemNodes[i]?.querySelector('source')?.textContent
                    || extractGoogleNewsSource(item)
                ),
            }))
            .filter(item => {
                const src = item.source.toLowerCase();
                return ALLOWED_SOURCES.some(allowed => src.includes(allowed));
            });

        return await enrichGoogleNewsImages(filtered);
    } catch {
        return [];
    }
}

async function enrichGoogleNewsImages(items) {
    if (!items.length) return items;

    const imageCache = getCache(CACHE_KEY_GOOGLE_IMAGE_LOOKUP) || {};
    const needsLookup = [];

    for (const item of items) {
        if (item.image) continue;

        if (Object.prototype.hasOwnProperty.call(imageCache, item.link)) {
            item.image = imageCache[item.link] || '';
            continue;
        }

        if (needsLookup.length < GOOGLE_IMAGE_LOOKUP_LIMIT) {
            needsLookup.push(item);
        }
    }

    await Promise.allSettled(needsLookup.map(async (item) => {
        const image = await fetchOgImageForGoogleItem(item.link);
        imageCache[item.link] = image || '';
        if (image) item.image = image;
    }));

    trimLookupCache(imageCache, GOOGLE_IMAGE_LOOKUP_CACHE_MAX);
    setCache(CACHE_KEY_GOOGLE_IMAGE_LOOKUP, imageCache);
    return items;
}

async function fetchOgImageForGoogleItem(url) {
    try {
        const html = await fetchViaProxy(url);
        return extractOgImageFromHtml(html);
    } catch {
        return '';
    }
}

function extractOgImageFromHtml(html) {
    if (!html || !html.trim()) return '';

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const metaSelectors = [
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]',
    ];

    for (const selector of metaSelectors) {
        const value = doc.querySelector(selector)?.getAttribute('content')?.trim() || '';
        if (value) return value;
    }

    const imgSrc = doc.querySelector('article img, main img, img')?.getAttribute('src')?.trim() || '';
    return imgSrc;
}

function trimLookupCache(cache, maxEntries) {
    const keys = Object.keys(cache);
    if (keys.length <= maxEntries) return;
    keys.slice(0, keys.length - maxEntries).forEach(key => delete cache[key]);
}

// Fallback wanneer <source> niet aanwezig is: bron staat soms in titel ("- Bron").
function extractGoogleNewsSource(item) {
    const title = item.title || '';
    const dashParts = title.split(' - ');
    if (dashParts.length > 1) return dashParts[dashParts.length - 1];
    return 'Onbekend';
}

// Omrop Fryslân sport RSS: filter op Cambuur-gerelateerde artikelen
async function fetchOmropFryslanSport() {
    return fetchOmropFryslanFiltered(OMROP_SPORT_RSS);
}

// Omrop Fryslân algemeen nieuws RSS: filter op Cambuur-gerelateerde artikelen
async function fetchOmropFryslanNieuws() {
    return fetchOmropFryslanFiltered(OMROP_NIEUWS_RSS);
}

async function fetchOmropFryslanFiltered(feedUrl) {
    try {
        const text = await fetchViaProxy(feedUrl);
        return parseRSS(text)
            .filter(itemMentionsCambuur)
            .map(item => ({
                title: item.title,
                link: item.link,
                pubDate: item.pubDate,
                image: item.image || '',
                source: 'Omrop Fryslân',
            }));
    } catch {
        return [];
    }
}

// Cambuur.nl: artikelen via dedicated Worker-endpoint. De Worker scrapt
// sitemap + artikel-pagina's en levert nette titels, datums, beschrijvingen
// en og:image's. Cloudflare cachet 10 minuten op de edge.
async function fetchCambuurNL() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
        try {
            const response = await fetch(CAMBUUR_NEWS_ENDPOINT, {
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Worker HTTP ${response.status}`);
            const articles = await response.json();
            if (!Array.isArray(articles)) return [];
            return articles.map(a => ({
                title: a.title,
                link: a.link,
                pubDate: a.pubDate,
                description: a.description || '',
                image: a.image || '',
                source: 'Cambuur.nl',
            }));
        } finally {
            clearTimeout(timeout);
        }
    } catch {
        return [];
    }
}

// Leeuwarder Courant: brede regionale feed, filter op Cambuur.
async function fetchLeeuwarderCourant() {
    try {
        const text = await fetchViaProxy(LC_RSS);
        return parseRSS(text)
            .filter(itemMentionsCambuur)
            .map(item => ({
                title: item.title,
                link: item.link,
                pubDate: item.pubDate,
                image: item.image || '',
                source: 'Leeuwarder Courant',
            }));
    } catch {
        return [];
    }
}

// Zoek "cambuur" in titel, description én volledige content (content:encoded).
// Zo pikken we ook artikelen op waarbij Cambuur alleen in de body wordt genoemd
// (bv. paywall-previews waar de teaser geen Cambuur noemt).
function itemMentionsCambuur(item) {
    const haystack = [
        item.title,
        item.description,
        item.content,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes('cambuur');
}

function cleanTitle(title) {
    // Google News voegt soms " - Bron" toe aan het einde van de titel
    const parts = title.split(' - ');
    if (parts.length > 1) {
        parts.pop();
        return parts.join(' - ');
    }
    return title;
}

function normalizeNewsSource(source) {
    const src = (source || '').trim();
    if (!src) return 'Onbekend';

    const lowered = src.toLowerCase();
    if (lowered.includes('sportclub cambuur') || lowered.includes('cambuur.nl')) {
        return 'Cambuur.nl';
    }

    return src;
}

function renderNieuws(items) {
    if (!items.length) {
        nieuwsList.innerHTML = '<div class="error-message">Geen nieuwsartikelen gevonden.</div>';
        return;
    }

    nieuwsList.innerHTML = items.map(item => {
        const imageHtml = item.image
            ? `<img class="news-image" src="${escapeHtml(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
            : '';
        return `
        <a href="${escapeHtml(item.link)}" class="news-card${item.image ? ' has-image' : ''}" target="_blank" rel="noopener">
            ${imageHtml}
            <div class="news-body">
                <h3>${escapeHtml(item.title)}</h3>
                <div class="news-meta">
                    <span class="news-source">${escapeHtml(item.source)}</span>
                    <time data-date="${escapeHtml(item.pubDate)}">${formatDate(item.pubDate)}</time>
                </div>
            </div>
        </a>`;
    }).join('');
}

// === Video's laden ===
// SC Cambuur: gratis YouTube RSS feed (0 API units)
// KKD: Search API met q=Cambuur (100 units per call)
async function loadVideos(forceRefresh = false) {
    // Check cache
    if (!forceRefresh) {
        const cached = getCache(CACHE_KEY_VIDEOS);
        if (cached) {
            renderVideos(cached);
            return;
        }
    }

    videosList.innerHTML = '<div class="loader">Video\'s laden...</div>';

    try {
        const [cambuurVideos, kkdVideos] = await Promise.all([
            fetchCambuurRSS(),
            kkdSearchDisabled ? Promise.resolve([]) : fetchKKDSearch(),
        ]);

        // Combineer en sorteer van nieuw naar oud
        const videos = [...cambuurVideos, ...kkdVideos]
            .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

        setCache(CACHE_KEY_VIDEOS, videos);
        renderVideos(videos);
    } catch {
        videosList.innerHTML = '<div class="error-message">Kon video\'s niet laden. Probeer het later opnieuw.</div>';
        const cached = getCache(CACHE_KEY_VIDEOS);
        if (cached) renderVideos(cached);
    }
}

// SC Cambuur via gratis YouTube RSS feed (0 API units)
async function fetchCambuurRSS() {
    try {
        const text = await fetchViaProxy(CAMBUUR_YT_RSS);
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        const entries = xml.querySelectorAll('entry');
        if (!entries.length) return [];

        return Array.from(entries).slice(0, 15).map(entry => {
            const videoId = entry.querySelector('videoId')?.textContent || '';
            return {
                id: videoId,
                title: decodeHtmlEntities(entry.querySelector('title')?.textContent || ''),
                channel: 'SC Cambuur',
                thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
                publishedAt: entry.querySelector('published')?.textContent || '',
            };
        });
    } catch {
        return [];
    }
}

// KKD via Search API met q=Cambuur (100 units per call)
async function fetchKKDSearch() {
    try {
        if (!YOUTUBE_API_KEY) return [];

        const params = new URLSearchParams({
            part: 'snippet',
            channelId: KKD_CHANNEL_ID,
            type: 'video',
            maxResults: '15',
            order: 'date',
            q: 'Cambuur',
            key: YOUTUBE_API_KEY,
        });
        const response = await fetch(`${YOUTUBE_SEARCH_URL}?${params}`);

        // Bij ongeldige/slecht geconfigureerde key niet blijven proberen binnen deze sessie.
        if (response.status === 400 || response.status === 401 || response.status === 403) {
            kkdSearchDisabled = true;
            return [];
        }

        if (!response.ok) return [];
        const data = await response.json();
        return (data.items || []).map(item => ({
            id: item.id.videoId,
            title: decodeHtmlEntities(item.snippet.title),
            channel: decodeHtmlEntities(item.snippet.channelTitle),
            thumbnail: `https://i.ytimg.com/vi/${item.id.videoId}/maxresdefault.jpg`,
            publishedAt: item.snippet.publishedAt,
        }));
    } catch {
        return [];
    }
}

function renderVideos(videos) {
    if (!videos.length) {
        videosList.innerHTML = '<div class="error-message">Geen video\'s gevonden.</div>';
        return;
    }

    videosList.innerHTML = videos.map(video => `
        <a href="https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}" class="video-card" target="_blank" rel="noopener">
            <img class="video-thumbnail" src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(video.title)}" loading="lazy" onerror="this.onerror=null;this.src=this.src.replace('maxresdefault','hqdefault')">
            <div class="video-info">
                <h3>${escapeHtml(video.title)}</h3>
                <span class="video-channel">${escapeHtml(video.channel)} · <time data-date="${escapeHtml(video.publishedAt)}">${formatDate(video.publishedAt)}</time></span>
            </div>
        </a>
    `).join('');
}

// === Hulpfuncties ===
function decodeHtmlEntities(text) {
    const div = document.createElement('div');
    div.innerHTML = text;
    return div.textContent;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMin = Math.floor(diffMs / 60000);
        const diffHrs = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMin < 1) return 'Zojuist';
        if (diffMin < 60) return `${diffMin} min geleden`;
        if (diffHrs < 24) return `${diffHrs} uur geleden`;
        if (diffDays < 7) return `${diffDays} dagen geleden`;

        return date.toLocaleDateString('nl-NL', {
            day: 'numeric',
            month: 'short',
            year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
        });
    } catch {
        return dateStr;
    }
}

function getCache(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const { data, timestamp } = JSON.parse(raw);
        if (Date.now() - timestamp > CACHE_DURATION) return null;
        return data;
    } catch {
        return null;
    }
}

function setCache(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch {
        // localStorage vol of niet beschikbaar
    }
}

function updateFooterYear() {
    if (!footerText) return;
    footerText.textContent = 'Cambuur 360. Alles rondom Cambuur.';
}

// === Podcasts laden ===
function formatDuration(raw) {
    if (!raw) return '';
    // Already formatted as HH:MM:SS or MM:SS
    if (raw.includes(':')) return raw;
    // Raw seconds (e.g. "2933")
    const total = parseInt(raw, 10);
    if (isNaN(total)) return raw;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

async function loadPodcasts(forceRefresh = false) {
    if (!forceRefresh) {
        const cached = getCache(CACHE_KEY_PODCASTS);
        if (cached) {
            renderPodcasts(cached);
            return;
        }
    }

    podcastsList.innerHTML = '<div class="loader">Podcasts laden...</div>';

    const [sportcast, hertenkamp] = await Promise.all([
        fetchPodcastFeed(SPORTCAST_RSS, 'Sportcast', 'Omrop Fryslân'),
        fetchPodcastFeed(HERTENKAMP_RSS, 'Hertenkamp', 'Leeuwarder Courant'),
    ]);

    const episodes = [...sportcast, ...hertenkamp]
        .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    if (!episodes.length) {
        podcastsList.innerHTML = '<div class="error-message">Kon podcasts niet laden. Probeer het later opnieuw.</div>';
        const cached = getCache(CACHE_KEY_PODCASTS);
        if (cached) renderPodcasts(cached);
        return;
    }

    setCache(CACHE_KEY_PODCASTS, episodes);
    renderPodcasts(episodes);
}

async function fetchPodcastFeed(feedUrl, podcastName, publisher) {
    try {
        const text = await fetchViaProxy(feedUrl);
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        const items = xml.querySelectorAll('item');
        if (!items.length) return [];

        return Array.from(items).map(item => {
            const enclosure = item.querySelector('enclosure');
            return {
                title: item.querySelector('title')?.textContent?.trim() || '',
                pubDate: item.querySelector('pubDate')?.textContent || '',
                audioUrl: enclosure?.getAttribute('url') || '',
                duration: item.querySelector('duration')?.textContent || '',
                podcast: podcastName,
                publisher: publisher,
            };
        }).filter(ep => ep.audioUrl)
          .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
          .slice(0, 10);
    } catch {
        return [];
    }
}

function renderPodcasts(episodes) {
    if (!episodes.length) {
        podcastsList.innerHTML = '<div class="error-message">Geen podcasts gevonden.</div>';
        return;
    }

    podcastsList.innerHTML = episodes.map(ep => `
        <div class="podcast-card">
            <div class="podcast-header">
                <span class="podcast-badge">${escapeHtml(ep.podcast)}</span>
                <time data-date="${escapeHtml(ep.pubDate)}">${formatDate(ep.pubDate)}</time>
            </div>
            <h3>${escapeHtml(ep.title)}</h3>
            <div class="podcast-player">
                <audio preload="none" controls>
                    <source src="${escapeHtml(ep.audioUrl)}" type="audio/mpeg">
                </audio>
            </div>
            <span class="podcast-publisher">${escapeHtml(ep.publisher)}</span>
        </div>
    `).join('');
}

// === Service Worker registratie ===
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

// === Dynamische tijd-updates (elke 60 seconden) ===
function updateTimeLabels() {
    document.querySelectorAll('time[data-date]').forEach(el => {
        el.textContent = formatDate(el.dataset.date);
    });
}
setInterval(updateTimeLabels, 60000);

// === Auto-refresh elke 30 minuten ===
setInterval(() => {
    loadNieuws(true);
    loadVideos(true);
    loadPodcasts(true);
}, CACHE_DURATION);

// === Start! ===
updateFooterYear();
loadNieuws();
loadVideos();
loadPodcasts();
