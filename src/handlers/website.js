// src/handlers/website.js
const { ok, bad } = require('../lib/responses');
const { fetchHtmlMeta, analyzeImage } = require('../lib/meta');

async function handle({ url, name = null }) {
  // Validate URL
  let parsed;
  try { 
    parsed = new URL(url); 
  } catch { 
    return bad(400, 'Invalid URL'); 
  }

  // Fetch and parse metadata
  const meta = await fetchHtmlMeta(url);

  // If fetch completely failed, return error
  if (!meta.ok) {
    return bad(meta.status || 500, meta.error || 'Failed to fetch website');
  }

  // Get favicon (use extracted one or Google fallback)
  const favicon = meta.favicon 
    ? (meta.favicon.startsWith('http') ? meta.favicon : new URL(meta.favicon, url).toString())
    : `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`;

  // Analyze primary image for hotlink blocking
  const imageAnalysis = meta.image ? analyzeImage(meta.image) : null;

  // Build structured response
  const response = {
    kind: 'url',
    request: { 
      name,
      providedUrl: url 
    },
    
    // Core website info
    url: meta.canonical || url, // Use canonical if available
    host: parsed.hostname,
    favicon,
    
    // Metadata from OG/meta tags
    meta: {
      ok: true,
      title: meta.title || '',
      description: meta.description || '',
      image: meta.image || '',
      imageAnalysis,
      siteName: meta.siteName,
      type: meta.type,
      author: meta.author,
      themeColor: meta.themeColor,
      keywords: meta.keywords
    },
    
    // Structured data from JSON-LD
    structured: meta.structured || null,
    
    // Social links from JSON-LD
    socialLinks: meta.structured?.sameAs || null,
    
    // Keep raw data for debugging (optional - remove in production)
    // _debug: {
    //   jsonLdBlocks: meta.jsonLdBlocks
    // }
  };

  // Clean up: remove null/undefined values for cleaner response
  Object.keys(response).forEach(key => {
    if (response[key] === null || response[key] === undefined) {
      delete response[key];
    }
  });

  Object.keys(response.meta).forEach(key => {
    if (response.meta[key] === null || response.meta[key] === undefined) {
      delete response.meta[key];
    }
  });

  return ok(response);
}

module.exports = { handle };