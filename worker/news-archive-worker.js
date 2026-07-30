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
const KV_KEY_META = 'news-archive-meta';

const CAMBUUR_NEWS_ENDPOINT =
    'https://cambuur-feed-proxy.ewoudwesterhuis.workers.dev/?endpoint=cambuur-news';

// RSS-bronnen. `mentionsRequired: true` betekent dat de feed brede content
// bevat en items alleen tellen als "cambuur" in titel of beschrijving voorkomt.
const RSS_SOURCES = [
    {
        name: 'Google News',
        url: 'https://news.google.com/rss/search?q=%22SC+Cambuur%22+OR+%22Cambuur%22&hl=nl&gl=NL&ceid=NL:nl',
        mentionsRequired: false,
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

        const [itemsRaw, metaRaw] = await Promise.all([
            env.CAMBUUR_ARCHIVE.get(KV_KEY_ARCHIVE),
            env.CAMBUUR_ARCHIVE.get(KV_KEY_META),
        ]);

        const items = itemsRaw ? JSON.parse(itemsRaw) : [];
        const meta = metaRaw ? JSON.parse(metaRaw) : { updatedAt: null, count: items.length };

        return new Response(
            JSON.stringify({
                updatedAt: meta.updatedAt,
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

    const existingRaw = await env.CAMBUUR_ARCHIVE.get(KV_KEY_ARCHIVE);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];

    const merged = mergeArchive(existing, fresh);

    await Promise.all([
        env.CAMBUUR_ARCHIVE.put(KV_KEY_ARCHIVE, JSON.stringify(merged)),
        env.CAMBUUR_ARCHIVE.put(
            KV_KEY_META,
            JSON.stringify({ updatedAt: Date.now(), count: merged.length }),
        ),
    ]);
}

async function collectFreshItems() {
    const results = await Promise.all([
        ...RSS_SOURCES.map(src => fetchRssSource(src)),
        fetchCambuurNL(),
    ]);
    return results.flat();
}

async function fetchRssSource({ name, url, mentionsRequired }) {
    try {
        const xml = await fetchWithTimeout(url);
        if (!xml) return [];
        const parsed = parseRss(xml).map(item => ({
            ...item,
            source: resolveSource(name, item.link, item.description),
        }));
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
                title: existing.title || item.title,
                link: item.link,
                pubDate: existing.pubDate || item.pubDate,
                image: existing.image || item.image || '',
                source: existing.source || item.source,
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

    const sorted = Array.from(byLink.values())
        .filter(item => getItemAge(item) >= cutoff)
        .sort((a, b) => getItemAge(b) - getItemAge(a));

    // Cross-source dedup op genormaliseerde titel (Google mirrort soms
    // artikelen die ook direct via LC/Omrop binnenkomen).
    const seenTitles = new Set();
    const result = [];
    for (const item of sorted) {
        const key = (item.title || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .slice(0, 60);
        if (key && seenTitles.has(key)) continue;
        if (key) seenTitles.add(key);
        result.push(item);
        if (result.length >= NEWS_ARCHIVE_MAX_ITEMS) break;
    }
    return result;
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
