// src/handlers/website.js
const { ok, bad } = require('../lib/responses');
const { fetchHtmlMeta /*, extractJsonLd if you added it */ } = require('../lib/meta');

async function handle({ url, name = null }) {
  let parsed;
  try { parsed = new URL(url); } catch { return bad(400, 'Invalid URL'); }

  const meta = await fetchHtmlMeta(url);
  const favicon = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`;

  // const structured = meta?._raw ? extractJsonLd(meta._raw) : null;
  if (meta && meta._raw) delete meta._raw;

  return ok({
    kind: 'url',
    request: { name },                  // <-- important
    url,
    host: parsed.hostname,
    favicon,
    meta: {
      ok: !!meta?.ok,
      title: meta?.title || '',
      description: meta?.description || '',
      image: meta?.image || ''
    }
    // , structured
  });
}
module.exports = { handle };
