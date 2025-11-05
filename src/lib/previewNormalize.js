// src/lib/previewNormalize.js
const { normalizeAddress } = require('./addressNormalize');

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
 * Remove all null/undefined/empty values from an object recursively
 */
function stripNulls(obj) {
  if (Array.isArray(obj)) {
    return obj.filter(item => item !== null && item !== undefined && item !== '');
  }
  
  if (obj && typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip null, undefined, empty strings
      if (value === null || value === undefined || value === '') continue;
      
      // Recursively clean nested objects
      if (typeof value === 'object') {
        const cleanedValue = stripNulls(value);
        // Only add if object/array has content
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
 * Normalize and clean response body
 * In production: removes debug info, nulls, and duplicate data
 * In development: keeps enrichment data for debugging
 */
function normalizePreview(body = {}) {
  const kind = body.kind || null;
  const og = body.meta || {};
  const place = body.place || {};
  const enr = body.enrichment || {};
  const req = body.request || {};
  const isProd = process.env.NODE_ENV === 'production';

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

  // FOUNDING YEAR
  body.foundingYear = first(body.foundingYear, enr.foundingYear);

  // LEADERSHIP DATA - use the structured leaderData object, not individual fields
  if (body.leaderData && Object.keys(body.leaderData).length > 0) {
    // Keep leaderData as-is
  } else {
    delete body.leaderData; // Remove if empty
  }
  
  // Remove legacy ceoName field - replaced by leaderData
  delete body.ceoName;

  // HQ ADDRESS - normalize to consistent format
  const rawHqAddress = first(body.headquartersAddress, place.address, enr.headquartersAddress);
  body.headquartersAddress = normalizeAddress(rawHqAddress);

  // LOCATION for map pin (only if from place data)
  body.location = first(body.location, place.location) || null;

  // CONTACT INFO - only include if present
  body.phone = first(body.phone, place.phone, enr.phone);
  body.email = first(body.email, place.email, enr.email);

  // IMAGE: prefer OG image, but handle LinkedIn hotlink blocking
  const ogImage = og.image || null;
  const imageInfo = og.imageAnalysis || {};
  
  // For LinkedIn, don't duplicate image in top-level if it's hotlink-blocked
  if (kind === 'linkedin' && imageInfo.hotlinkBlocked) {
    body.image = null; // Keep only in meta for reference
  } else {
    body.image = first(body.image, ogImage) || null;
  }
  
  // LinkedIn-specific: only include 'limited' if true
  if (kind === 'linkedin' && !body.limited) {
    delete body.limited;
    delete body.limited_reason;
  }

  // FAVICON
  const siteHost = hostFrom(body.website);
  const previewHost =
    body.host ||
    siteHost ||
    (kind === 'linkedin' ? 'www.linkedin.com' : null) ||
    (place.mapLink ? hostFrom(place.mapLink) : null);
  body.favicon = first(body.favicon, s2Favicon(website));

  // PRODUCTION CLEANUP
  if (isProd) {
    // Remove debug/internal fields
    delete body.enrichment;
    delete body._raw;
    delete body.jsonLdBlocks;
    
    // Remove duplicate/redundant data
    if (body.url === body.website) {
      delete body.url; // url is just canonical, keep website
    }
    
    // Simplify structured data - remove if it's just echoing top-level fields
    if (body.structured) {
      const hasUniqueData = 
        body.structured.email || 
        body.structured.telephone ||
        body.structured.addressComponents;
      
      if (!hasUniqueData) {
        delete body.structured; // Top-level fields already have this info
      }
    }
    
    // Simplify dataSources to just a boolean flag
    if (body.dataSources) {
      body.enrichedWithAI = body.dataSources.enrichedWithAI || false;
      body.hasStructuredData = body.dataSources.hasJsonLd || false;
      delete body.dataSources;
    }
  } else {
    // DEVELOPMENT: Keep enrichment but clean it up
    if (body.enrichment) {
      // Remove fields that were already null/not used
      if (!body.enrichment.leaderData) delete body.enrichment.leaderData;
      if (!body.enrichment.sources) delete body.enrichment.sources;
      if (body.enrichment.leaderConfidence === null) delete body.enrichment.leaderConfidence;
    }
  }

  // FINAL CLEANUP: Strip all nulls, empty strings, empty objects
  return stripNulls(body);
}

module.exports = { normalizePreview };