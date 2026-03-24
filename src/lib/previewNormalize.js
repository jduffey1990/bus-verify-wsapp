// src/lib/previewNormalize.js
const { normalizeAddress } = require('./addressNormalize');

function hostFrom(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return null; }
}

function s2Favicon(host) {
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null;
}

function nonEmpty(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function first(...values) {
  for (const value of values) {
    if (nonEmpty(value)) return value;
  }
  return null;
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return null;
}

function isLinkedIn(url) {
  return typeof url === 'string' && /(^|\.)linkedin\.com/i.test(url);
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanUrl(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function cleanEmail(value) {
  const email = cleanString(value);
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function cleanYear(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1600 && value <= 2100) {
    return value;
  }

  if (typeof value === 'string' && /^\d{4}$/.test(value.trim())) {
    const year = Number(value.trim());
    return year >= 1600 && year <= 2100 ? year : null;
  }

  return null;
}

function cleanSocialLinks(values) {
  if (!Array.isArray(values)) return null;

  const seen = new Set();
  const cleaned = [];

  for (const value of values) {
    const url = cleanUrl(value);
    if (!url) continue;

    const key = url.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    cleaned.push(url);
  }

  return cleaned.length ? cleaned : null;
}

function cleanCategories(values) {
  if (!Array.isArray(values)) return null;

  const seen = new Set();
  const cleaned = [];

  for (const value of values) {
    const category = cleanString(value);
    if (!category) continue;
    if (category.length < 3 || category.length > 50) continue;
    if (/lorem|ipsum|test|example/i.test(category)) continue;

    const key = category.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    cleaned.push(category);

    if (cleaned.length >= 5) break;
  }

  return cleaned.length ? cleaned : null;
}

function cleanLeaderData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const cleaned = {};
  const allowedRoles = ['ceo', 'cto', 'cfo', 'coo', 'founder'];

  for (const role of allowedRoles) {
    const name = cleanString(value[role]);
    if (!name) continue;
    cleaned[role] = name;
  }

  return Object.keys(cleaned).length ? cleaned : null;
}

function cleanPlace(place = {}) {
  if (!place || typeof place !== 'object' || Array.isArray(place)) return null;

  const cleaned = stripNulls({
    name: cleanString(place.name),
    address: cleanString(place.address),
    phone: cleanString(place.phone),
    website: cleanUrl(place.website),
    mapLink: cleanUrl(place.mapLink),
    gmapsUrl: cleanUrl(place.gmapsUrl),
    rating: typeof place.rating === 'number' ? place.rating : null,
    reviewsCount: Number.isInteger(place.reviewsCount) ? place.reviewsCount : null,
    location: place.location && typeof place.location === 'object' ? place.location : null,
    categories: cleanCategories(place.categories)
  });

  return Object.keys(cleaned).length ? cleaned : null;
}

/**
 * Remove all null/undefined/empty values from an object recursively.
 */
function stripNulls(obj) {
  if (Array.isArray(obj)) {
    return obj.filter(item => item !== null && item !== undefined && item !== '');
  }

  if (obj && typeof obj === 'object') {
    const cleaned = {};

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined || value === '') continue;

      if (typeof value === 'object') {
        const cleanedValue = stripNulls(value);

        if (Array.isArray(cleanedValue) && cleanedValue.length > 0) {
          cleaned[key] = cleanedValue;
        } else if (!Array.isArray(cleanedValue) && Object.keys(cleanedValue).length > 0) {
          cleaned[key] = cleanedValue;
        }
      } else {
        cleaned[key] = value;
      }
    }

    return cleaned;
  }

  return obj;
}

/**
 * Normalize preview responses into a stable contract:
 * keep persistable brand basics at the top level and quarantine
 * display-only context under previewOnly.
 */
function normalizePreview(body = {}) {
  const kind = cleanString(body.kind);
  const meta = body.meta || {};
  const place = body.place || {};
  const request = body.request || {};
  const enrichment = body.enrichment || {};

  const name = cleanString(first(
    body.name,
    request.name,
    place.name,
    enrichment.canonicalName,
    meta.title ? String(meta.title).replace(/\|\s*LinkedIn/i, '').trim() : null
  ));

  let website = cleanUrl(first(
    body.website,
    place.website,
    kind === 'url' ? body.url : null,
    enrichment.website
  ));
  if (isLinkedIn(website)) website = null;

  const shortDescription = cleanString(first(
    body.shortDescription,
    meta.description ? String(meta.description).split('\n')[0] : null,
    enrichment.shortDescription
  ));

  const headquartersAddress = normalizeAddress(first(
    body.headquartersAddress,
    place.address,
    enrichment.headquartersAddress
  ));

  const foundingYear = cleanYear(first(body.foundingYear, enrichment.foundingYear));
  const email = cleanEmail(first(body.email, place.email, enrichment.email));
  const socialLinks = cleanSocialLinks(firstArray(body.socialLinks, body.structured?.sameAs));
  const categories = cleanCategories(firstArray(body.categories, enrichment.categories));

  const imageInfo = meta.imageAnalysis && typeof meta.imageAnalysis === 'object'
    ? meta.imageAnalysis
    : null;
  let image = cleanUrl(first(body.image, meta.image));
  if (kind === 'linkedin' && imageInfo?.hotlinkBlocked) {
    image = null;
  }

  const previewHost =
    body.host ||
    hostFrom(website) ||
    (kind === 'linkedin' ? 'www.linkedin.com' : null) ||
    hostFrom(place.mapLink);
  const favicon = cleanUrl(first(body.favicon, s2Favicon(previewHost)));

  const dataQuality = stripNulls({
    enrichedWithAI: body.dataSources?.enrichedWithAI ? true : null,
    hasStructuredData: body.dataSources?.hasJsonLd ? true : null,
    hasGooglePlaces: body.dataSources?.hasGooglePlaces ? true : null
  });

  const previewOnly = stripNulls({
    sourceUrl: cleanUrl(first(
      request.providedUrl,
      kind === 'address' ? place.mapLink : body.url,
      kind === 'address' ? null : website
    )),
    themeColor: cleanString(meta.themeColor),
    imageAnalysis: imageInfo,
    leaderData: cleanLeaderData(body.leaderData),
    place: cleanPlace(place),
    dataQuality: Object.keys(dataQuality).length ? dataQuality : null,
    isStorefront: body.isStorefront === true ? true : null,
    limited: kind === 'linkedin' && body.limited ? true : null,
    limitedReason: kind === 'linkedin' ? cleanString(body.limited_reason) : null
  });

  return stripNulls({
    kind,
    name,
    website,
    shortDescription,
    image,
    favicon,
    headquartersAddress,
    foundingYear,
    email,
    socialLinks,
    categories,
    previewOnly: Object.keys(previewOnly).length ? previewOnly : null
  });
}

module.exports = { normalizePreview };
