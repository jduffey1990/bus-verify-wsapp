// src/handlers/linkedin.js
const { ok, bad } = require('../lib/responses');
const { fetchHtmlMeta, analyzeImage } = require('../lib/meta');
const { normalizeUrl, classifyPath, looksLikeLoginWall } = require('../lib/linkedin');

async function handle({ url, name = null }) {
  // Validate and normalize LinkedIn URL
  let normalized;
  try { 
    normalized = normalizeUrl(url); 
  } catch { 
    return bad(400, 'Please provide a valid LinkedIn URL'); 
  }

  const { type, slug } = classifyPath(normalized.pathname);
  
  // Unsupported LinkedIn path (not a company page)
  if (type === 'unknown') {
    return ok({
      kind: 'linkedin',
      url: normalized.toString(),
      type,
      limited: true,
      limited_reason: 'unsupported_path',
      favicon: 'https://www.google.com/s2/favicons?domain=www.linkedin.com&sz=64',
    });
  }

  // Fetch metadata
  const meta = await fetchHtmlMeta(normalized.toString());
  
  if (!meta.ok) {
    return bad(meta.status || 500, meta.error || 'Failed to fetch LinkedIn page');
  }

  // Check for login wall
  const raw = meta._raw || '';
  const hasContent = !!(meta.title || meta.description || meta.image);
  const limited = looksLikeLoginWall(raw) && !hasContent;

  // Analyze image for hotlink blocking
  const imgInfo = meta.image ? analyzeImage(meta.image) : null;

  // Build response
  const response = {
    kind: 'linkedin',
    request: {
      name,
      providedUrl: url
    },
    url: normalized.toString(),
    type,
    slug,
    host: 'www.linkedin.com',
    favicon: 'https://www.google.com/s2/favicons?domain=www.linkedin.com&sz=64',
    
    meta: {
      ok: true,
      title: meta.title || '',
      description: meta.description || '',
      image: meta.image || '',
      imageAnalysis: imgInfo
    },
    
    limited,
    limited_reason: limited ? 'login_wall' : null
  };

  // Clean up empty values
  Object.keys(response).forEach(key => {
    if (response[key] === null || response[key] === undefined || response[key] === '') {
      delete response[key];
    }
  });

  Object.keys(response.meta).forEach(key => {
    if (response.meta[key] === null || response.meta[key] === undefined || response.meta[key] === '') {
      delete response.meta[key];
    }
  });

  return ok(response);
}

module.exports = { handle };
