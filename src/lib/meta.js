// src/lib/meta.js
const cheerio = require('cheerio');
const he = require('he');
const { fetchText } = require('./http');

/**
 * Extract all JSON-LD blocks from HTML
 * Returns array of parsed JSON-LD objects
 */
function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const jsonLdBlocks = [];

  $('script[type="application/ld+json"]').each((_, elem) => {
    try {
      const text = $(elem).html();
      if (!text) return;
      
      // Clean up common issues
      const cleaned = text
        .trim()
        .replace(/\r\n/g, '\n')
        .replace(/\t/g, ' ');
      
      const parsed = JSON.parse(cleaned);
      
      // Handle @graph wrapper (common pattern)
      if (parsed['@graph']) {
        jsonLdBlocks.push(...parsed['@graph']);
      } else {
        jsonLdBlocks.push(parsed);
      }
    } catch (err) {
      console.warn('Failed to parse JSON-LD block:', err.message);
    }
  });

  return jsonLdBlocks;
}

/**
 * Find the most relevant Organization or LocalBusiness schema
 */
function findOrganizationSchema(jsonLdBlocks) {
  const orgTypes = [
    'Organization',
    'Corporation', 
    'LocalBusiness',
    'ProfessionalService',
    'Store',
    'Restaurant'
  ];

  // Look for exact type match first
  for (const type of orgTypes) {
    const found = jsonLdBlocks.find(block => 
      block['@type'] === type || 
      (Array.isArray(block['@type']) && block['@type'].includes(type))
    );
    if (found) return found;
  }

  // Fallback: any block with organization-like fields
  return jsonLdBlocks.find(block => 
    block.name || block.legalName || block.url || block.address
  );
}

/**
 * Extract structured data from JSON-LD
 */
function parseStructuredData(jsonLdBlocks) {
  if (!jsonLdBlocks.length) return null;

  const org = findOrganizationSchema(jsonLdBlocks);
  if (!org) return null;

  const structured = {
    '@type': org['@type'],
    name: org.name || org.legalName || null,
    alternateName: org.alternateName || null,
    url: org.url || null,
    description: org.description || null,
    foundingDate: org.foundingDate || null,
    logo: org.logo?.url || org.logo || null,
    image: org.image?.url || org.image || null,
  };

  // Extract address (can be nested)
  if (org.address) {
    const addr = org.address;
    if (typeof addr === 'string') {
      structured.address = addr;
    } else if (addr['@type'] === 'PostalAddress') {
      const parts = [
        addr.streetAddress,
        addr.addressLocality,
        addr.addressRegion,
        addr.postalCode,
        addr.addressCountry
      ].filter(Boolean);
      structured.address = parts.length ? parts.join(', ') : null;
      structured.addressComponents = {
        street: addr.streetAddress || null,
        city: addr.addressLocality || null,
        state: addr.addressRegion || null,
        zip: addr.postalCode || null,
        country: addr.addressCountry || null
      };
    }
  }

  // Extract CEO/founder if present
  if (org.founder) {
    const founder = Array.isArray(org.founder) ? org.founder[0] : org.founder;
    structured.founder = founder.name || founder || null;
  }

  // Contact info
  if (org.telephone) structured.telephone = org.telephone;
  if (org.email) structured.email = org.email;

  // Social media
  if (org.sameAs) {
    structured.sameAs = Array.isArray(org.sameAs) ? org.sameAs : [org.sameAs];
  }

  // Founding year from foundingDate
  if (org.foundingDate) {
    const match = org.foundingDate.match(/^(\d{4})/);
    if (match) structured.foundingYear = parseInt(match[1], 10);
  }

  return structured;
}

/**
 * Extract all metadata from HTML using proper parsing
 */
function extractMetadata(html) {
  const $ = cheerio.load(html);
  
  // Helper to get meta content by property or name
  const getMeta = (selectors) => {
    for (const sel of selectors) {
      const content = $(sel).attr('content');
      if (content) return he.decode(content).trim();
    }
    return null;
  };

  const metadata = {
    // Title (priority: OG > Twitter > <title> > meta name=title)
    title: getMeta([
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]'
    ]) || he.decode($('title').text() || '').trim(),

    // Description
    description: getMeta([
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]'
    ]),

    // Images
    image: getMeta([
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]'
    ]),

    // Canonical URL
    canonical: $('link[rel="canonical"]').attr('href') || 
               getMeta(['meta[property="og:url"]']),

    // Site name
    siteName: getMeta([
      'meta[property="og:site_name"]',
      'meta[name="application-name"]'
    ]),

    // Type
    type: getMeta(['meta[property="og:type"]']),

    // Locale
    locale: getMeta(['meta[property="og:locale"]']),

    // Author
    author: getMeta([
      'meta[name="author"]',
      'meta[property="article:author"]'
    ]),

    // Twitter handle
    twitterSite: getMeta(['meta[name="twitter:site"]']),
    
    // Favicon (multiple possible locations)
    favicon: $('link[rel="icon"]').attr('href') ||
             $('link[rel="shortcut icon"]').attr('href') ||
             $('link[rel="apple-touch-icon"]').attr('href'),

    // Theme color (useful for branding)
    themeColor: getMeta(['meta[name="theme-color"]']),

    // Keywords (less common now, but still useful)
    keywords: getMeta(['meta[name="keywords"]'])?.split(',').map(k => k.trim()).filter(Boolean)
  };

  // Clean up empty values
  Object.keys(metadata).forEach(key => {
    if (metadata[key] === null || metadata[key] === '' || 
        (Array.isArray(metadata[key]) && !metadata[key].length)) {
      delete metadata[key];
    }
  });

  return metadata;
}

/**
 * Fetch and parse HTML metadata from a URL
 */
async function fetchHtmlMeta(url) {
  const tryOnce = async (u) => {
    const r = await fetchText(u, { 
      timeoutMs: 10000, 
      headers: { 
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (compatible; CompanyBot/1.0)'
      }
    });

    if (!r.ok) {
      return { 
        ok: false, 
        status: r.status,
        error: `HTTP ${r.status}` 
      };
    }

    const html = r.text;
    
    // Extract all metadata
    const metadata = extractMetadata(html);
    
    // Extract JSON-LD structured data
    const jsonLdBlocks = extractJsonLd(html);
    const structured = parseStructuredData(jsonLdBlocks);

    return {
      ok: true,
      url: u,
      ...metadata,
      structured,
      jsonLdBlocks: jsonLdBlocks.length ? jsonLdBlocks : undefined, // for debugging
      _raw: html // Keep if you need it downstream
    };
  };

  try {
    // Try the URL as provided
    const first = await tryOnce(url);
    if (first.ok) return first;
    
    // If failed and it's an apex domain, try www. subdomain
    if (!first.ok || first.status === 0 || first.status >= 400) {
      try {
        const u = new URL(url);
        // Only try www. for apex domains (e.g., example.com not sub.example.com)
        if (!u.hostname.startsWith('www.') && u.hostname.split('.').length === 2) {
          const wwwUrl = new URL(u.toString());
          wwwUrl.hostname = `www.${u.hostname}`;
          
          const second = await tryOnce(wwwUrl.toString());
          if (second.ok) return second;
        }
      } catch (wwwErr) {
        console.warn('www. fallback failed:', wwwErr.message);
      }
    }

    return first; // Return original error
  } catch (err) {
    return { 
      ok: false, 
      error: 'fetch_failed',
      message: err.message 
    };
  }
}

/**
 * Analyze image URL for hotlink detection
 */
function analyzeImage(url = '') {
  if (!url) return { url: '', host: '', hotlinkBlocked: false };
  
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    
    // Common hotlink-blocked domains
    const blockedDomains = [
      'media.licdn.com',
      'media-exp1.licdn.com',
      'media-exp2.licdn.com',
      'static.licdn.com'
    ];
    
    const hotlinkBlocked = blockedDomains.some(domain => 
      host === domain || host.endsWith(`.${domain}`)
    );
    
    return { url, host, hotlinkBlocked };
  } catch {
    return { url, host: '', hotlinkBlocked: false };
  }
}

module.exports = { 
  fetchHtmlMeta, 
  extractJsonLd,
  extractMetadata,
  parseStructuredData,
  analyzeImage 
};