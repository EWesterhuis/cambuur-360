// === Cambuur Feed Proxy Worker ===
//
// Deploy: kopieer deze code naar de Worker `cambuur-feed-proxy` in het
// Cloudflare-dashboard.
//
// GET /?url=<feed-url>            CORS-proxy voor whitelisted hosts.
// GET /?endpoint=cambuur-news     JSON-array met recente Cambuur.nl-artikelen.

const ALLOWED_HOSTS = new Set([
  'news.google.com',
  'www.omropfryslan.nl',
  'argyf2.omropfryslan.nl',
  'www.cambuur.nl',
  'cambuur.nl',
  'lc.nl',
  'www.lc.nl',
  'www.youtube.com',
  'www.omnycontent.com',
]);

const UA = 'Mozilla/5.0 (compatible; CambuurFeedProxy/1.0)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CAMBUUR_NEWS_FEED = 'https://www.cambuur.nl/nieuws/feed/';
const CAMBUUR_MAX_AGE_DAYS = 30;
const CAMBUUR_MAX_ARTICLES = 30;
const CAMBUUR_CACHE_SECONDS = 600;
// Artikelpagina's (alleen voor og:image/og:description) veranderen zelden; lang cachen
// houdt het aantal requests naar cambuur.nl laag.
const CAMBUUR_ARTICLE_CACHE_SECONDS = 86400;

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint');

    if (endpoint === 'cambuur-news') {
      return handleCambuurNews();
    }

    return handleProxy(url);
  },
};

async function handleProxy(url) {
  const target = url.searchParams.get('url');
  if (!target) {
    return jsonError(400, 'Missing ?url parameter');
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return jsonError(400, 'Invalid url');
  }
  if (!ALLOWED_HOSTS.has(parsed.host)) {
    return jsonError(403, `Host not allowed: ${parsed.host}`);
  }

  const upstream = await fetch(parsed.toString(), {
    headers: { 'User-Agent': UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  const headers = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handleCambuurNews() {
  try {
    const articles = await fetchCambuurNews();
    return new Response(JSON.stringify(articles), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${CAMBUUR_CACHE_SECONDS}`,
        ...CORS,
      },
    });
  } catch (err) {
    return jsonError(502, `cambuur-news failed: ${err.message}`);
  }
}

// Nieuwe cambuur.nl (WordPress, 2026): /nieuws/feed/ levert titel, link en
// pubDate, maar geen afbeelding en meestal een lege description.
async function fetchCambuurNews() {
  const xml = await fetchText(CAMBUUR_NEWS_FEED, CAMBUUR_CACHE_SECONDS);
  const cutoff = Date.now() - CAMBUUR_MAX_AGE_DAYS * 86400_000;

  const items = parseRssItems(xml)
    .filter(item => item.title && item.link.includes('/nieuws/'))
    .filter(item => {
      const ts = Date.parse(item.pubDate);
      return isNaN(ts) || ts >= cutoff;
    })
    .slice(0, CAMBUUR_MAX_ARTICLES);

  const enriched = await Promise.allSettled(items.map(enrichFromArticle));
  return enriched.map((r, i) => (r.status === 'fulfilled' ? r.value : items[i]));
}

// Best-effort: haalt og:image/og:description op; bij een fout blijft het item zonder beeld.
async function enrichFromArticle(item) {
  const html = await fetchText(item.link, CAMBUUR_ARTICLE_CACHE_SECONDS);
  return {
    ...item,
    description: item.description || decodeEntities(metaContent(html, 'og:description')),
    image: metaContent(html, 'og:image') || item.image,
  };
}

function parseRssItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1];
    const description = stripHtml(extractTag(body, 'description'))
      .replace(/\s*\[…\]\s*$/, '…');
    items.push({
      title: extractTag(body, 'title'),
      link: extractTag(body, 'link'),
      pubDate: extractTag(body, 'pubDate'),
      description,
      image: '',
      source: 'Cambuur.nl',
    });
  }
  return items;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

// Zoekt <meta property|name="prop" content="..."> ongeacht attribuutvolgorde.
function metaContent(html, prop) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = tag.match(/\b(?:property|name)=["']([^"']+)["']/i);
    if (key && key[1].toLowerCase() === prop) {
      const content = tag.match(/\bcontent=["']([^"']*)["']/i);
      if (content) return content[1];
    }
  }
  return '';
}

function stripHtml(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchText(url, cacheTtl) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA },
    cf: { cacheTtl, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return r.text();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
