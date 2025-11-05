// src/lib/enrichURL.js
const { askOpenAI, setIfMissing, CFG } = require('./_enrichBase');
const { normalizePreview } = require('./previewNormalize');

function hostnameOf(u) {
  try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return null; }
}

/**
 * Build facts object from scraped data, prioritizing structured data
 */
function buildFacts(body) {
  const structured = body?.structured || {};
  const meta = body?.meta || {};
  const request = body?.request || {};

  // Priority order: user input > JSON-LD > OG tags > title tag
  const name = request.name 
    || structured.name 
    || structured.alternateName
    || meta.siteName
    || meta.title 
    || null;

  const website = body?.url || structured.url || null;
  const description = structured.description || meta.description || null;
  
  // Extract what we already know from structured data
  const knownFacts = {
    name,
    website,
    description,
    foundingYear: structured.foundingYear || null,
    address: structured.address || null,
    phone: structured.telephone || null,
    email: structured.email || null,
    founder: structured.founder || null,
    logo: structured.logo || meta.image || null,
    socialLinks: body?.socialLinks || structured.sameAs || null
  };

  // Determine what fields are missing and need AI enrichment
  const missingFields = [];
  if (!knownFacts.name) missingFields.push('name');
  if (!knownFacts.description) missingFields.push('shortDescription');
  if (!knownFacts.foundingYear) missingFields.push('foundingYear');
  if (!knownFacts.address) missingFields.push('headquartersAddress');
  // Note: We don't ask AI for ceoName - too prone to hallucination
  // Only use structured.founder if present in JSON-LD
  if (!body.categories) missingFields.push('categories');

  return {
    ...knownFacts,
    missingFields,
    hasStructuredData: !!body?.structured,
    providedSources: [body?.url].filter(Boolean)
  };
}

/**
 * Determine if AI enrichment is needed
 */
function needsEnrichment(facts) {
  // If we have structured data with most fields, skip AI
  if (facts.hasStructuredData && facts.missingFields.length <= 2) {
    return false;
  }
  
  // Always enrich if we're missing critical fields
  const criticalFields = ['name', 'shortDescription', 'categories'];
  const missingCritical = facts.missingFields.some(f => criticalFields.includes(f));
  
  return missingCritical || facts.missingFields.length > 2;
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

  // Pre-fill from structured data (highest confidence)
  setIfMissing(body, 'name', facts.name);
  setIfMissing(body, 'website', facts.website);
  setIfMissing(body, 'shortDescription', facts.description);
  setIfMissing(body, 'foundingYear', facts.foundingYear);
  setIfMissing(body, 'headquartersAddress', facts.address);
  setIfMissing(body, 'phone', facts.phone);
  setIfMissing(body, 'email', facts.email);
  
  // Only set founder/CEO if from structured data (reliable source)
  if (facts.founder && facts.hasStructuredData) {
    setIfMissing(body, 'founder', facts.founder);
  }

  // Add metadata about data sources
  body.dataSources = {
    hasJsonLd: facts.hasStructuredData,
    hasOpenGraph: !!body?.meta?.description,
    enrichedWithAI: false
  };

  // Only call AI if we're missing significant data
  if (needsEnrichment(facts)) {
    const system =
      'You are a company metadata normalizer. ' +
      'Fill ONLY the missing fields using your world knowledge. ' +
      'Prioritize accuracy over completeness - if unsure, return null for that field. ' +
      'Set confidence based on how certain you are (0.0 = guess, 1.0 = certain). ' +
      'Return ONLY valid JSON matching the schema.';

    const userPayload = {
      task: `Fill missing company fields: [${facts.missingFields.join(', ')}]`,
      inputs: {
        name: facts.name,
        website: facts.website,
        description: facts.description,
        knownData: {
          foundingYear: facts.foundingYear,
          address: facts.address,
          socialLinks: facts.socialLinks
        }
      },
      required_output_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canonicalName:       { type: ['string','null'] },
          shortDescription:    { type: ['string','null'] },
          website:             { type: ['string','null'] },
          foundingYear:        { type: ['integer','null'], minimum: 1600, maximum: 2100 },
          headquartersAddress: { type: ['string','null'] },
          leaderData:          { 
            type: ['object','null'],
            description: 'C-suite executives. Keys: ceo, cto, cfo, coo, founder. Values: full names.',
            properties: {
              ceo: { type: ['string','null'] },
              cto: { type: ['string','null'] },
              cfo: { type: ['string','null'] },
              coo: { type: ['string','null'] },
              founder: { type: ['string','null'] }
            },
            additionalProperties: false
          },
          categories:          { type: ['array','null'], items: { type: 'string' } },
          confidence:          { type: 'number', minimum: 0, maximum: 1 },
          leaderConfidence:    { type: ['number','null'], minimum: 0, maximum: 1, description: 'Separate confidence for leadership data' },
          sources:             { type: ['array','null'], items: { type: 'string' } }
        }
      },
      rules: [
        'Only fill fields that are in the missingFields list',
        'Do not include providedSources in sources array',
        'Use broad industry categories (max 3): Technology, Retail, Healthcare, Finance, etc.',
        'If you cannot confidently determine a value, return null and lower confidence',
        'For categories, prefer established industry terms over vague descriptions',
        'CRITICAL - leaderData: Only include if you have HIGH confidence (>0.8) and preferably a source',
        'CRITICAL - leaderData: Use full names only (e.g., "John Smith", not "John S." or "Mr. Smith")',
        'CRITICAL - leaderData: If unsure about ANY executive name, set leaderConfidence to 0.3 or lower',
        'Set leaderConfidence separately from overall confidence - be MORE conservative with people names',
        'CRITICAL - Address format: Return addresses as "City, State" for US (e.g., "San Francisco, CA") or "City, Country" for international (e.g., "London, United Kingdom")',
        'CRITICAL - Address format: Do NOT include street addresses, zip codes, or building numbers in headquartersAddress'
      ]
    };

    const enr = await askOpenAI({ system, userPayload });

    if (enr.ok && enr.data) {
      // Sanitize sources: remove provided source host & duplicates
      const providedHosts = (facts.providedSources || []).map(hostnameOf).filter(Boolean);
      if (Array.isArray(enr.data.sources)) {
        const seen = new Set();
        enr.data.sources = enr.data.sources.filter((s) => {
          const h = hostnameOf(s);
          if (!s || !h) return false;
          if (providedHosts.includes(h)) return false;
          if (seen.has(h)) return false;
          seen.add(h);
          return true;
        });
        if (!enr.data.sources.length) enr.data.sources = null;
      }

      const conf = typeof enr.data.confidence === 'number' ? enr.data.confidence : 0;
      const highEnough = conf >= (CFG.min_conf || 0.5);
      
      // Separate confidence for leadership data (more strict)
      // If AI explicitly returns null, it means "I have no confidence in leadership data"
      const leaderConf = typeof enr.data.leaderConfidence === 'number' 
        ? enr.data.leaderConfidence 
        : 0; // Default to 0 if not provided (AI doesn't know leaders)
      const leaderHighEnough = leaderConf >= 0.7; // Higher threshold for people names

      // Attach raw enrichment for debugging/telemetry
      body.enrichment = {
        ...enr.data,
        appliedToFields: facts.missingFields,
        wasApplied: highEnough,
        leaderDataApplied: leaderHighEnough
      };

      body.dataSources.enrichedWithAI = true;
      body.dataSources.aiConfidence = conf;
      body.dataSources.leaderConfidence = leaderConf;

      // Merge only if confidence is high enough
      if (highEnough) {
        setIfMissing(body, 'name', enr.data.canonicalName);
        setIfMissing(body, 'website', enr.data.website);
        setIfMissing(body, 'shortDescription', enr.data.shortDescription);
        setIfMissing(body, 'foundingYear', enr.data.foundingYear);
        setIfMissing(body, 'headquartersAddress', enr.data.headquartersAddress);
        
        // Categories: prefer AI if we have none, but validate
        if (!body.categories && enr.data.categories) {
          // Filter out garbage categories
          const validCategories = enr.data.categories.filter(cat => 
            cat && 
            cat.length > 2 && 
            cat.length < 50 &&
            !/lorem|ipsum|test|example/i.test(cat)
          );
          if (validCategories.length) {
            body.categories = validCategories.slice(0, 3); // Max 3
          }
        }
        
        // Leadership data: only merge if high confidence AND has valid data
        if (leaderHighEnough && enr.data.leaderData && typeof enr.data.leaderData === 'object') {
          const leaders = {};
          const validRoles = ['ceo', 'cto', 'cfo', 'coo', 'founder'];
          
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
                name.length > 50 ||  // Shorter max
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
      } else {
        console.log(`Skipping AI enrichment - confidence ${conf} below threshold ${CFG.min_conf}`);
      }
    }
  } else {
    console.log('Skipping AI enrichment - sufficient data from structured sources');
  }

  const normalized = normalizePreview(body);
  return { statusCode, headers, body: JSON.stringify(normalized) };
}

module.exports = { handle };