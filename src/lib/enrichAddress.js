// src/lib/enrichAddress.js
const { askOpenAI, setIfMissing, CFG } = require('./_enrichBase');
const { normalizePreview } = require('./previewNormalize');
const { normalizeAddress } = require('./addressNormalize');

function hostnameOf(u) {
  try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return null; }
}

/**
 * Build facts from Google Places API data
 */
function buildFacts(body) {
  const place = body?.place || {};
  const request = body?.request || {};
  
  // Track provided sources (don't cite these)
  const providedSources = [];
  if (place.mapLink) providedSources.push(place.mapLink);
  if (place.gmapsUrl) providedSources.push(place.gmapsUrl);
  
  return {
    name: request.name || place.name || null,
    storeName: place.name || null,  // The actual storefront name
    address: place.address || null,
    website: place.website || null,
    phone: place.phone || null,
    categories: place.categories || null,
    location: place.location || null,
    rating: place.rating || null,
    reviewsCount: place.reviewsCount || null,
    providedSources,
    hasPlaceData: !!place.name
  };
}

/**
 * Determine if AI enrichment is needed and what to enrich
 */
function needsEnrichment(facts) {
  if (!facts.hasPlaceData) {
    return { needed: false, reason: 'no_place_data' };
  }
  
  // For addresses, AI enrichment is useful for:
  // 1. Identifying parent brand (if storefront)
  // 2. Adding description
  // 3. Finding brand HQ
  // 4. Finding brand founding year
  
  const missingFields = [];
  if (!facts.website) missingFields.push('website');
  // Always try to get description from AI
  missingFields.push('shortDescription');
  
  // Only enrich if we're missing critical brand info
  return {
    needed: missingFields.length > 0,
    missingFields
  };
}

async function handle(lambdaResponse) {
  const headers = lambdaResponse?.headers || {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };
  const statusCode = lambdaResponse?.statusCode ?? 200;
  const body = typeof lambdaResponse?.body === 'string'
    ? JSON.parse(lambdaResponse.body)
    : (lambdaResponse?.body || lambdaResponse);

  const facts = buildFacts(body);
  
  // Pre-fill from Google Places data (highest confidence)
  setIfMissing(body, 'name', facts.name || facts.storeName);
  setIfMissing(body, 'website', facts.website);
  setIfMissing(body, 'headquartersAddress', facts.address);
  setIfMissing(body, 'phone', facts.phone);
  if (!body.categories && facts.categories) {
    body.categories = facts.categories;
  }

  // Add metadata about data sources
  body.dataSources = {
    hasGooglePlaces: facts.hasPlaceData,
    hasOpenGraph: false,
    enrichedWithAI: false
  };

  const enrichmentCheck = needsEnrichment(facts);
  
  if (enrichmentCheck.needed) {
    const system =
      'You are a company metadata normalizer for physical business locations. ' +
      'The location may be a single storefront of a larger brand, or an independent business. ' +
      'Your task: identify the parent brand if applicable, and provide relevant business details. ' +
      'Prioritize accuracy - if unsure whether this is a brand storefront, be conservative. ' +
      'Return ONLY valid JSON matching the schema.';

    const userPayload = {
      task: `Analyze business location and fill missing fields: [${enrichmentCheck.missingFields.join(', ')}]`,
      inputs: {
        storeName: facts.storeName,
        address: facts.address,
        website: facts.website,
        categories: facts.categories,
        rating: facts.rating,
        reviewsCount: facts.reviewsCount
      },
      required_output_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canonicalName:       { 
            type: ['string','null'],
            description: 'Parent brand name if this is a storefront, or business name'
          },
          shortDescription:    { 
            type: ['string','null'],
            description: 'One sentence neutral description of the business/brand'
          },
          website:             { 
            type: ['string','null'],
            description: 'Official brand website if known'
          },
          foundingYear:        { 
            type: ['integer','null'], 
            minimum: 1600, 
            maximum: 2100,
            description: 'Brand founding year if known and confident'
          },
          headquartersAddress: { 
            type: ['string','null'],
            description: 'Brand HQ address if different from this location'
          },
          leaderData:          { 
            type: ['object','null'],
            description: 'C-suite executives of parent brand (not store managers). Keys: ceo, founder',
            properties: {
              ceo: { type: ['string','null'] },
              founder: { type: ['string','null'] }
            },
            additionalProperties: false
          },
          categories:          { 
            type: ['array','null'], 
            items: { type: 'string' },
            description: 'Broader industry categories if applicable'
          },
          isStorefront:        {
            type: ['boolean','null'],
            description: 'true if this is a location of a larger brand, false if independent'
          },
          confidence:          { 
            type: 'number', 
            minimum: 0, 
            maximum: 1,
            description: 'Overall confidence in the enrichment'
          },
          leaderConfidence:    { 
            type: ['number','null'], 
            minimum: 0, 
            maximum: 1,
            description: 'Separate confidence for leadership data'
          },
          sources:             { 
            type: ['array','null'], 
            items: { type: 'string' }
          }
        }
      },
      rules: [
        'If this appears to be an independent business (not a chain), set isStorefront: false and use the location name as canonicalName',
        'If this is a storefront of a larger brand, set isStorefront: true and provide brand-level info',
        'For storefronts: website should be brand website, not this location page',
        'For storefronts: headquartersAddress should be brand HQ in format "City, State" (US) or "City, Country" (international)',
        'CRITICAL - If this location IS the headquarters (not a storefront), return NULL for headquartersAddress - we already have it',
        'Leadership: Only include if you are highly confident (>0.7) about the parent brand CEO/founder',
        'CRITICAL - Leadership: Use ONLY clean names like "John Smith" - NO titles, NO prefixes (CEO, Cofounder, etc.), NO descriptive text',
        'CRITICAL - Leadership: If you only know partial info ("Cofounders: X, Y, and others"), return NULL instead',
        'Do not cite Google Maps URLs or the provided address as sources',
        'If guessing, lower confidence significantly (0.3-0.6)',
        'Set leaderConfidence separately - be MORE conservative with people names',
        'Address format: Return headquartersAddress as "City, State" for US or "City, Country" for international - NO street addresses or zip codes'
      ]
    };

    const enr = await askOpenAI({ system, userPayload });

    if (enr.ok && enr.data) {
      // Sanitize sources: remove Google Maps URLs and address strings
      const providedHosts = facts.providedSources.map(hostnameOf).filter(Boolean);
      if (Array.isArray(enr.data.sources)) {
        const seen = new Set();
        enr.data.sources = enr.data.sources.filter((s) => {
          if (!s) return false;
          const h = hostnameOf(s);
          // Reject non-URLs and Google Maps hosts
          if (!h) return false;
          if (providedHosts.includes(h)) return false;
          if (h.includes('google.com')) return false;
          if (seen.has(h)) return false;
          seen.add(h);
          return true;
        });
        if (!enr.data.sources.length) enr.data.sources = null;
      }

      const conf = typeof enr.data.confidence === 'number' ? enr.data.confidence : 0;
      const leaderConf = typeof enr.data.leaderConfidence === 'number' 
        ? enr.data.leaderConfidence 
        : 0;

      // Field-specific thresholds
      const thresholds = {
        canonicalName: Math.max(CFG.min_conf, 0.5),
        website: Math.max(CFG.min_conf, 0.6),       // Higher: websites are critical
        foundingYear: Math.max(CFG.min_conf, 0.6),
        headquartersAddress: Math.max(CFG.min_conf, 0.6),
        shortDescription: Math.max(CFG.min_conf, 0.5),
        categories: Math.max(CFG.min_conf, 0.5)
      };

      const passes = (field) => {
        const threshold = thresholds[field] || CFG.min_conf;
        return conf >= threshold;
      };

      const leaderHighEnough = leaderConf >= 0.7;

      // Attach enrichment data
      body.enrichment = {
        ...enr.data,
        appliedToFields: enrichmentCheck.missingFields,
        wasApplied: conf >= CFG.min_conf,
        leaderDataApplied: leaderHighEnough
      };

      body.dataSources.enrichedWithAI = true;
      body.dataSources.aiConfidence = conf;
      body.dataSources.leaderConfidence = leaderConf;

      // Flag whether this is a storefront or independent business
      if (typeof enr.data.isStorefront === 'boolean') {
        body.isStorefront = enr.data.isStorefront;
      }

      // Merge with field-specific thresholds
      if (passes('canonicalName')) {
        setIfMissing(body, 'name', enr.data.canonicalName);
      }
      
      if (passes('website') && enr.data.website) {
        setIfMissing(body, 'website', enr.data.website);
      }
      
      if (passes('shortDescription')) {
        setIfMissing(body, 'shortDescription', enr.data.shortDescription);
      }
      
      if (passes('foundingYear')) {
        setIfMissing(body, 'foundingYear', enr.data.foundingYear);
      }
      
      // For storefronts, HQ might be different from the location
      if (passes('headquartersAddress') && enr.data.headquartersAddress) {
        // Only override if:
        // 1. AI explicitly says it's a storefront AND
        // 2. The HQ address is meaningfully different from the location
        if (enr.data.isStorefront) {
          const aiHq = normalizeAddress(enr.data.headquartersAddress);
          const locationHq = normalizeAddress(facts.address);
          
          // Only use AI's HQ if it's a different city
          if (aiHq && locationHq && aiHq !== locationHq) {
            body.headquartersAddress = aiHq;
          }
          // Otherwise keep the location address (it IS the HQ)
        }
      }

      // Categories with validation
      if (passes('categories') && enr.data.categories) {
        const validCategories = enr.data.categories.filter(cat => 
          cat && 
          cat.length > 2 && 
          cat.length < 50 &&
          !/lorem|ipsum|test|example/i.test(cat)
        );
        
        // Merge with existing categories from Places API
        const existingCats = body.categories || [];
        const allCats = [...new Set([...existingCats, ...validCategories])];
        
        if (allCats.length) {
          body.categories = allCats.slice(0, 3); // Max 3
        }
      }

      // Leadership data with strict validation
      if (leaderHighEnough && enr.data.leaderData && typeof enr.data.leaderData === 'object') {
        const leaders = {};
        const validRoles = ['ceo', 'founder']; // Limited for address-based lookups
        
        for (const [role, name] of Object.entries(enr.data.leaderData)) {
          if (!validRoles.includes(role.toLowerCase()) || typeof name !== 'string') {
            continue;
          }
          
          // Reject names with titles/prefixes
          const invalidPrefixes = /^(ceo|cto|cfo|founder|cofounder|co-founder|president|vp|director|mr\.|ms\.|mrs\.|dr\.)/i;
          if (invalidPrefixes.test(name.trim())) {
            console.warn(`Rejecting leader name with prefix: "${name}"`);
            continue;
          }
          
          // Reject names with descriptive text
          if (name.includes(':') || name.includes('and others') || name.includes(',')) {
            console.warn(`Rejecting complex leader description: "${name}"`);
            continue;
          }
          
          // Must be valid name format
          if (name.length < 3 || 
              name.length > 50 ||  // Shorter max for names
              !/^[A-Za-z\s\-'.]+$/.test(name) ||
              name.split(' ').length < 2) {
            continue;
          }
          
          leaders[role.toLowerCase()] = name.trim();
        }
        
        if (Object.keys(leaders).length > 0) {
          body.leaderData = leaders;
        }
      }
    }
  } else {
    console.log(`Skipping AI enrichment for address - ${enrichmentCheck.reason}`);
  }

  const normalized = normalizePreview(body);
  return { statusCode, headers, body: JSON.stringify(normalized) };
}

module.exports = { handle };