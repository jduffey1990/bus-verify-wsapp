// src/lib/previewNormalize.js
function hostFrom(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return null; }
}
function s2Favicon(host) {
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
}
function nonEmpty(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}
function first(...vals) {
  for (const v of vals) if (nonEmpty(v)) return v;
  return null;
}
function isLinkedIn(u) {
  return typeof u === 'string' && /(^|\.)linkedin\.com/i.test(u);
}

/**
 * Mutates and returns `body` with normalized top-level fields:
 * name, website, shortDescription, foundingYear, ceoName, headquartersAddress, location, favicon, image.
 * Prefers deterministic sources (Places/URL/OG) over model enrichment; never uses LinkedIn as website.
 */
function normalizePreview(body = {}) {
  const kind = body.kind || null;
  const og = body.meta || {};
  const place = body.place || {};
  const enr = body.enrichment || {};
  const req = body.request || {};

  // NAME
  const name = first(
    body.name,
    req.name,
    place.name,
    enr.canonicalName,
    (og.title && String(og.title).replace(/\|\s*LinkedIn/i, '').trim())
  );
  body.name = name || null;

  // WEBSITE (never LinkedIn)
  let website = first(
    body.website,
    place.website,
    body.url,    // for website previews, this *is* the site
    enr.website
  );
  if (isLinkedIn(website)) website = null;
  body.website = website || null;

  // SHORT DESCRIPTION
  const shortDescription = first(
    body.shortDescription,
    (og.description && String(og.description).split('\n')[0]),
    enr.shortDescription
  );
  body.shortDescription = shortDescription || null;

  // FOUNDING YEAR / CEO / HQ
  body.foundingYear = first(body.foundingYear, enr.foundingYear);
  body.ceoName = first(body.ceoName, enr.ceoName);
  body.headquartersAddress = first(body.headquartersAddress, place.address, enr.headquartersAddress);

  // LOCATION for map pin
  body.location = first(body.location, place.location) || null;

  // IMAGE: prefer OG image, then LinkedIn/company logo if you ever set it, else null
  body.image = first(body.image, og.image) || null;

  // FAVICON: choose from website host, or the preview host, or LinkedIn, or gmaps
  const siteHost = hostFrom(body.website);
  const previewHost =
    body.host ||
    siteHost ||
    (kind === 'linkedin' ? 'www.linkedin.com' : null) ||
    (place.mapLink ? hostFrom(place.mapLink) : null);
  body.favicon = first(body.favicon, s2Favicon(website));

  return body;
}

module.exports = { normalizePreview };
