const { fetchText } = require('./http');

const decodeEntities = (s = '') =>
  s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
   .replace(/&lt;/g,'<').replace(/&gt;/g,'>');

const analyzeImage = (url = '') => {
  try {
    const u = new URL(url);
    return { url, host: u.hostname, hotlinkBlocked: u.hostname.endsWith('media.licdn.com') };
  } catch {
    return { url: '', host: '', hotlinkBlocked: false };
  }
};

async function fetchHtmlMeta(url) {
  const tryOnce = async (u) => {
    const r = await fetchText(u, { timeoutMs: 10000, headers: { Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache' }});
    if (!r.ok) return { ok: false, status: r.status };
    const txt = r.text;
    const get = (re) => (txt.match(re)?.[1] || '').trim();
    const title =
      get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
      get(/<title[^>]*>([^<]{0,200})<\/title>/i) ||
      get(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i);
    const description =
      get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) ||
      get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i);
    const image =
      get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) ||
      get(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i);
    return { ok: true, title, description, image, _raw: txt };
  };

  try {
    const first = await tryOnce(url);
    if (first.ok || first.status && first.status !== 0) return first;
    // If initial threw, try www. for apex host
    const u = new URL(url);
    if (u.hostname.split('.').length <= 2) {
      const u2 = new URL(u.toString()); u2.hostname = `www.${u.hostname}`;
      return await tryOnce(u2.toString());
    }
    return { ok: false, error: 'fetch_failed' };
  } catch {
    // www. fallback
    try {
      const u = new URL(url);
      if (u.hostname.split('.').length <= 2) {
        const u2 = new URL(u.toString()); u2.hostname = `www.${u.hostname}`;
        return await tryOnce(u2.toString());
      }
    } catch {}
    return { ok: false, error: 'fetch_failed' };
  }
}

module.exports = { fetchHtmlMeta, decodeEntities, analyzeImage };
