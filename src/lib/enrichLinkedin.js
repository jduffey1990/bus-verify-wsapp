// src/lib/enrichLinkedin.js
const { askOpenAI, setIfMissing, CFG } = require('./_enrichBase');
const { normalizePreview } = require('./previewNormalize');

function isLinkedIn(u) {
  return typeof u === 'string' && /(^|\.)linkedin\.com/i.test(u);
}

function buildFacts(body) {
  const meta = body?.meta || {};
  const request = body?.request || {};
  
  // Extract name, cleaning LinkedIn suffix
  const name = request.name
    || (meta.title ? meta.title.replace(/\|\s*LinkedIn/i, '').trim() : null)
    || null;
  
  const linkedinUrl = body?.url || null;
  const description = meta.description || null;
  
  // Determine what fields are missing
  const missingFields = [];
  if (!name) missingFields.push('canonicalName');
  if (!body.website) missingFields.push('website');
  if (!body.foundingYear) missingFields.push('foundingYear');
  if (!body.headquartersAddress) missingFields.push('headquartersAddress');
  if (!body.categories) missingFields.push('categories');
  
  return {
    name,
    linkedinUrl,
    description,
    missingFields
  };
}

/**
 * Determine if AI enrichment is needed
 */
function needsEnrichment(facts) {
  // Always need enrichment for LinkedIn - rarely has structured data
  const criticalFields = ['name', 'website', 'categories'];
  const missingCritical = facts.missingFields.some(f => criticalFields.includes(f));
  
  return missingCritical || facts.missingFields.length > 1;
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

  // Pre-fill name from LinkedIn title
  setIfMissing(body, 'name', facts.name);

  // Add metadata about data sources
  body.dataSources = {
    hasJsonLd: false, // LinkedIn rarely has JSON-LD
    hasOpenGraph: !!body?.meta?.description,
    enrichedWithAI: false
  };

  // Only enrich if needed
  if (needsEnrichment(facts)) {
    const system =
      'You are a company metadata normalizer for LinkedIn company pages. ' +
      'Use your world knowledge PLUS the provided LinkedIn metadata. ' +
      'CRITICAL: NEVER return a LinkedIn URL as the official website. ' +
      'Prioritize accuracy - if unsure, return null and lower confidence. ' +
      'Return ONLY valid JSON matching the schema.';

    const userPayload = {
      task: `Fill missing company fields from LinkedIn: [${facts.missingFields.join(', ')}]`,
      inputs: {
        name: facts.name,
        linkedinUrl: facts.linkedinUrl,
        description: facts.description
      },
      required_output_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canonicalName:       { type: ['string','null'] },
          website:             { type: ['string','null'], description: 'Official homepage - NEVER LinkedIn' },
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
          leaderConfidence:    { type: ['number','null'], minimum: 0, maximum: 1 },
          sources:             { type: ['array','null'], items: { type: 'string' } }
        }
      },
      rules: [
        'CRITICAL: NEVER return LinkedIn URLs for website or in sources array',
        'Only fill fields in the missingFields list',
        'Use broad industry categories (max 3): Technology, Retail, Healthcare, Finance, etc.',
        'LinkedIn-specific: Be more conservative - use 0.6+ confidence for most fields, 0.7+ for leadership',
        'If guessing without strong evidence, set confidence to 0.5 or lower',
        'Leadership: Only include if confidence >0.7 and you have strong evidence',
        'Set leaderConfidence separately - be MORE conservative with people names',
        'Address format: Return as "City, State" for US (e.g., "San Francisco, CA") or "City, Country" for international',
        'Address format: Do NOT include street addresses or zip codes in headquartersAddress'
      ]
    };

    const enr = await askOpenAI({ system, userPayload });

    if (enr.ok && enr.data) {
      // CRITICAL: Sanitize LinkedIn URLs
      if (isLinkedIn(enr.data.website)) {
        console.warn('AI returned LinkedIn URL as website - rejecting');
        enr.data.website = null;
      }
      
      if (Array.isArray(enr.data.sources)) {
        enr.data.sources = enr.data.sources.filter(s => s && !isLinkedIn(s));
        if (!enr.data.sources.length) enr.data.sources = null;
      }

      // Per-field confidence thresholds (LinkedIn: stricter than website scraping)
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
        appliedToFields: facts.missingFields,
        wasApplied: conf >= CFG.min_conf,
        leaderDataApplied: leaderHighEnough
      };

      body.dataSources.enrichedWithAI = true;
      body.dataSources.aiConfidence = conf;
      body.dataSources.leaderConfidence = leaderConf;

      // Merge with field-specific thresholds
      if (passes('canonicalName')) {
        setIfMissing(body, 'name', enr.data.canonicalName);
      }
      
      if (passes('website') && enr.data.website && !isLinkedIn(enr.data.website)) {
        setIfMissing(body, 'website', enr.data.website);
      }
      
      if (passes('foundingYear')) {
        setIfMissing(body, 'foundingYear', enr.data.foundingYear);
      }
      
      if (passes('headquartersAddress')) {
        setIfMissing(body, 'headquartersAddress', enr.data.headquartersAddress);
      }

      // Categories with validation
      if (!body.categories && passes('categories') && enr.data.categories) {
        const validCategories = enr.data.categories.filter(cat => 
          cat && 
          cat.length > 2 && 
          cat.length < 50 &&
          !/lorem|ipsum|test|example/i.test(cat)
        );
        if (validCategories.length) {
          body.categories = validCategories.slice(0, 3);
        }
      }

      // Leadership data with strict validation
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
              name.length > 50 ||
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
    console.log('Skipping AI enrichment - sufficient data from LinkedIn metadata');
  }

  // Final safety check: ensure no LinkedIn URLs leaked through
  if (isLinkedIn(body.website)) {
    console.warn('LinkedIn URL detected in final output - removing');
    body.website = null;
  }

  const normalized = normalizePreview(body);
  return { statusCode, headers, body: JSON.stringify(normalized) };
}

module.exports = { handle };