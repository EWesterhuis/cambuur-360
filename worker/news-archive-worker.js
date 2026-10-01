// === Cambuur 360 — Nieuws-archief Worker ===
//
// Deze Cloudflare Worker houdt een centraal, persistent nieuws-archief bij in
// Workers KV. Elke 5 minuten (cron trigger) worden alle RSS-bronnen opgehaald,
// gefilterd op Cambuur-mentions en samengevoegd met het bestaande archief.
// Zo blijven artikelen behouden nadat ze uit de originele RSS-feed zijn
// verdwenen én is de eerste render voor iedere gebruiker instant, ongeacht op
// welk device ze de app openen.
//
// Endpoint (GET /):
//   Retourneert { updatedAt, count, items: [...] } als JSON met CORS-headers.
//   Items zijn gesorteerd van nieuw → oud en bevatten alleen render-velden.
//
// Retentie: NEWS_MAX_AGE_DAYS dagen, cap op NEWS_ARCHIVE_MAX_ITEMS items.

const NEWS_MAX_AGE_DAYS = 90;
const NEWS_ARCHIVE_MAX_ITEMS = 500;
const KV_KEY_ARCHIVE = 'news-archive';

const CAMBUUR_NEWS_ENDPOINT =
    'https://cambuur-feed-proxy.ewoudwesterhuis.workers.dev/?endpoint=cambuur-news';

// RSS-bronnen. `mentionsRequired: true` betekent dat de feed brede content
// bevat en items alleen tellen als "cambuur" in titel of beschrijving voorkomt.
const RSS_SOURCES = [
    {
        name: 'Google News',
        url: 'https://news.google.com/rss/search?q=%22SC+Cambuur%22+OR+%22Cambuur%22&hl=nl&gl=NL&ceid=NL:nl',
        mentionsRequired: false,
        isGoogleNews: true,
    },
    {
        name: 'Omrop Fryslân',
        url: 'https://www.omropfryslan.nl/rss/sport.xml',
        mentionsRequired: true,
    },
    {
        name: 'Omrop Fryslân',
        url: 'https://www.omropfryslan.nl/rss/nieuws.xml',
        mentionsRequired: true,
    },
    {
        name: 'Leeuwarder Courant',
        url: 'https://www.lc.nl/rss',
        mentionsRequired: true,
    },
];

// Toegestane bronnen voor Google News-items. Google News aggregeert wereldwijd
// veel Nederlandse bronnen; we willen alleen de kwaliteitsbronnen tonen die we
// ook via directe RSS/scrape ophalen. Voorkomt dat er obscure bronnen zonder
// beeld of context in het archief belanden.
const ALLOWED_GOOGLE_SOURCES = [
    'leeuwarder courant', 'lc.nl',
    'omrop fryslân', 'omrop fryslan', 'omropfryslan.nl',
    'voetbalzone',
    'voetbal international',
];

const FETCH_TIMEOUT_MS = 10000;

export default {
    async fetch(request, env, ctx) {
        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        if (request.method !== 'GET') {
            return new Response('Method Not Allowed', { status: 405 });
        }

        const url = new URL(request.url);

        // Optionele handmatige refresh (bv. voor debug): GET /?refresh=1
        if (url.searchParams.get('refresh') === '1') {
            ctx.waitUntil(refreshArchive(env));
        }

        const { items, updatedAt } = readArchive(await env.CAMBUUR_ARCHIVE.get(KV_KEY_ARCHIVE));

        return new Response(
            JSON.stringify({
                updatedAt,
                count: items.length,
                items,
            }),
            {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=300', // 5 min edge/browser cache
                },
            },
        );
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(refreshArchive(env));
    },
};

// === Archive refresh (cron + handmatig) ===
async function refreshArchive(env) {
    const fresh = await collectFreshItems();

    const { items: existing } = readArchive(await env.CAMBUUR_ARCHIVE.get(KV_KEY_ARCHIVE));

    const merged = mergeArchive(existing, fresh);

    // Free tier staat maar 1.000 KV-writes/dag toe: alleen schrijven bij een wijziging.
    if (JSON.stringify(merged) === JSON.stringify(existing)) return;

    await env.CAMBUUR_ARCHIVE.put(
        KV_KEY_ARCHIVE,
        JSON.stringify({ updatedAt: Date.now(), items: merged }),
    );
}

// Ondersteunt ook het oude formaat (kale array zonder updatedAt).
function readArchive(raw) {
    const data = raw ? JSON.parse(raw) : null;
    if (Array.isArray(data)) return { items: data, updatedAt: null };
    return { items: data?.items || [], updatedAt: data?.updatedAt ?? null };
}

async function collectFreshItems() {
    const results = await Promise.all([
        ...RSS_SOURCES.map(src => fetchRssSource(src)),
        fetchCambuurNL(),
    ]);
    return results.flat();
}

async function fetchRssSource({ name, url, mentionsRequired, isGoogleNews }) {
    try {
        const xml = await fetchWithTimeout(url);
        if (!xml) return [];
        let parsed = parseRss(xml);

        if (isGoogleNews) {
            // Google News: gebruik de <source>-tag uit het item (echte bron zoals
            // "Leeuwarder Courant"), en knip de " - Bron"-suffix uit de titel.
            parsed = parsed
                .map(item => ({
                    ...item,
                    title: cleanTitle(item.title),
                    source: normalizeSource(item.sourceLabel) || extractSourceFromTitle(item.title) || name,
                }))
                .filter(item => {
                    const src = (item.source || '').toLowerCase();
                    return ALLOWED_GOOGLE_SOURCES.some(allowed => src.includes(allowed));
                });
        } else {
            parsed = parsed.map(item => ({
                ...item,
                source: resolveSource(name, item.link, item.description),
            }));
        }

        return mentionsRequired ? parsed.filter(itemMentionsCambuur) : parsed;
    } catch {
        return [];
    }
}

async function fetchCambuurNL() {
    try {
        const raw = await fetchWithTimeout(CAMBUUR_NEWS_ENDPOINT);
        if (!raw) return [];
        const data = JSON.parse(raw);
        const items = Array.isArray(data?.items) ? data.items : [];
        return items.map(item => ({
            title: item.title || '',
            link: item.link || '',
            pubDate: item.pubDate || '',
            description: item.description || '',
            image: item.image || '',
            source: 'Cambuur.nl',
        }));
    } catch {
        return [];
    }
}

async function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Cambuur360-Archive/1.0' },
            cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!res.ok) return null;
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// === Merge / dedup / filter ===
function mergeArchive(archive, fresh) {
    const now = Date.now();
    const cutoff = now - NEWS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const byLink = new Map();

    for (const item of archive || []) {
        if (item?.link) byLink.set(item.link, { ...item });
    }

    for (const item of fresh || []) {
        if (!item?.link) continue;
        const existing = byLink.get(item.link);
        if (existing) {
            byLink.set(item.link, {
                // Fresh wint bij niet-lege title/source: zo worden eerdere
                // vervuilde entries (bv. \"Titel - LC\" of source \"Google News\")
                // vanzelf opgeschoond zodra een schone versie binnenkomt.
                title: item.title || existing.title,
                link: item.link,
                pubDate: existing.pubDate || item.pubDate,
                image: existing.image || item.image || '',
                source: item.source || existing.source,
                firstSeen: existing.firstSeen || now,
            });
        } else {
            byLink.set(item.link, {
                title: item.title || '',
                link: item.link,
                pubDate: item.pubDate || '',
                image: item.image || '',
                source: item.source || 'Onbekend',
                firstSeen: now,
            });
        }
    }

    // Sanitize: gooi bestaande vervuilde Google-items weg (bronnen buiten de
    // whitelist die ooit v\u00f3\u00f3r de filter-fix in KV zijn beland). Ook titels
    // van resterende Google-items ontdoen van de \" - Bron\"-suffix.
    for (const [link, item] of byLink) {
        if (isFromGoogleNews(item)) {
            const src = (item.source || '').toLowerCase();
            const allowed = ALLOWED_GOOGLE_SOURCES.some(a => src.includes(a));
            if (!allowed) {
                byLink.delete(link);
                continue;
            }
            item.title = cleanTitle(item.title);
        }
    }

    const sorted = Array.from(byLink.values())
        .filter(item => getItemAge(item) >= cutoff)
        .sort((a, b) => getItemAge(b) - getItemAge(a));

    // Cross-source dedup op genormaliseerde titel (Google mirrort soms
    // artikelen die ook direct via LC/Omrop/Cambuur.nl binnenkomen). Voorkeur:
    // niet-Google-bron met afbeelding boven Google News zonder beeld.
    const seenTitles = new Map(); // titelhash → index in result
    const result = [];
    for (const item of sorted) {
        const key = (item.title || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .slice(0, 60);
        if (!key) {
            result.push(item);
            continue;
        }
        if (seenTitles.has(key)) {
            const idx = seenTitles.get(key);
            if (isPreferredOver(item, result[idx])) {
                result[idx] = item;
            }
        } else {
            seenTitles.set(key, result.length);
            result.push(item);
        }
    }

    return result.slice(0, NEWS_ARCHIVE_MAX_ITEMS);
}

// Kies bij duplicate titels de "betere" versie: afbeelding aanwezig wint van
// geen afbeelding; bij gelijkspel wint een niet-Google-bron (originele feed)
// boven Google News (aggregator zonder beeld en met vervuilde titel).
function isPreferredOver(candidate, current) {
    const cHasImage = !!candidate.image;
    const curHasImage = !!current.image;
    if (cHasImage !== curHasImage) return cHasImage;

    const cIsGoogle = isFromGoogleNews(candidate);
    const curIsGoogle = isFromGoogleNews(current);
    if (cIsGoogle !== curIsGoogle) return !cIsGoogle;

    return getItemAge(candidate) > getItemAge(current);
}

function getItemAge(item) {
    if (item?.pubDate) {
        const ts = Date.parse(item.pubDate);
        if (!isNaN(ts)) return ts;
    }
    return Number(item?.firstSeen) || 0;
}

function itemMentionsCambuur(item) {
    const haystack = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();
    return haystack.includes('cambuur');
}

// Voor Google News: de <source>-tag zit in de description of link. Anders
// gebruiken we de generieke feed-naam.
function resolveSource(defaultName, link, description) {
    const hay = ((link || '') + ' ' + (description || '')).toLowerCase();
    if (hay.includes('lc.nl') || hay.includes('leeuwarder')) return 'Leeuwarder Courant';
    if (hay.includes('omropfryslan')) return 'Omrop Fryslân';
    if (hay.includes('voetbalzone')) return 'Voetbalzone';
    if (hay.includes('voetbal international') || hay.includes('vi.nl')) return 'Voetbal International';
    if (hay.includes('cambuur.nl')) return 'Cambuur.nl';
    return defaultName;
}

// Google News voegt " - <Bron>" achteraan de titel toe. Verwijder dat zodat de
// titel in de UI clean is en cross-source dedup werkt (LC/Omrop hebben die
// suffix niet).
function cleanTitle(title) {
    const parts = (title || '').split(' - ');
    if (parts.length > 1) {
        parts.pop();
        return parts.join(' - ').trim();
    }
    return title || '';
}

// Fallback: als <source>-tag ontbreekt bij Google News, probeer de bron uit de
// laatste " - X"-suffix van de titel te halen.
function extractSourceFromTitle(title) {
    const parts = (title || '').split(' - ');
    if (parts.length > 1) return parts[parts.length - 1].trim();
    return '';
}

// Normaliseer bronnamen zodat verschillende varianten samenvallen tot één
// consistente label (bijv. "Sportclub Cambuur" → "Cambuur.nl").
function normalizeSource(source) {
    const src = (source || '').trim();
    if (!src) return '';
    const lowered = src.toLowerCase();
    if (lowered.includes('sportclub cambuur') || lowered.includes('cambuur.nl')) return 'Cambuur.nl';
    if (lowered.includes('leeuwarder')) return 'Leeuwarder Courant';
    if (lowered.includes('omrop')) return 'Omrop Fryslân';
    return src;
}

// Detecteer of een item afkomstig is van de Google News-feed (link naar
// news.google.com). Gebruikt voor dedup-voorkeur: originele bron > Google.
function isFromGoogleNews(item) {
    return (item?.link || '').includes('news.google.com')
        || (item?.source || '').toLowerCase().includes('google news');
}

// === Minimalistische RSS 2.0 parser (geen DOMParser in Workers) ===
function parseRss(xml) {
    const items = [];
    const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml))) {
        const body = match[1];
        items.push({
            title: extractTag(body, 'title'),
            link: extractTag(body, 'link'),
            pubDate: extractTag(body, 'pubDate'),
            description: extractTag(body, 'description'),
            image: extractImage(body),
            // Google News zet de daadwerkelijke bron in een <source> tag; overige
            // feeds hebben die vaak niet. Leeg = fallback naar feed-naam / regex.
            sourceLabel: extractTag(body, 'source'),
        });
    }
    return items;
}

function extractTag(xml, tag) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = xml.match(re);
    if (!m) return '';
    let value = m[1];
    // Strip CDATA
    value = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    // Decode enkele veelvoorkomende entities (voldoende voor titels)
    value = value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');
    return value.trim();
}

function extractImage(body) {
    // <enclosure url="..." type="image/...">
    const enclosure = body.match(
        /<enclosure\b[^>]*url=["']([^"']+)["'][^>]*type=["']image\/[^"']+["']/i,
    ) || body.match(/<enclosure\b[^>]*type=["']image\/[^"']+["'][^>]*url=["']([^"']+)["']/i);
    if (enclosure) return enclosure[1];

    // <media:content url="..."> / <media:thumbnail url="...">
    const media = body.match(/<media:(?:content|thumbnail)\b[^>]*url=["']([^"']+)["']/i);
    if (media) return media[1];

    // <img src="..."> in description/content:encoded
    const img = body.match(/<img\b[^>]*src=["']([^"']+)["']/i);
    if (img) return img[1];

    return '';
}
