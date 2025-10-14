// src/lib/enrichLinkedin.js
const { askOpenAI, setIfMissing, CFG } = require('./_enrichBase');
const { normalizePreview } = require('./previewNormalize');

function buildFacts(body) {
  const name = body?.request?.name
    || (body?.meta?.title ? body.meta.title.replace(/\|\s*LinkedIn/i, '').trim() : null)
    || null;
  const linkedinUrl = body?.url || null;
  const og = body?.meta || {}; // { title, description, image }
  return { name, linkedinUrl, og };
}

function isLinkedIn(u) {
  return typeof u === 'string' && /(^|\.)linkedin\.com/i.test(u);
}

function ensureAllKeys(obj) {
  // LinkedIn variant: no shortDescription, no founders
  const shape = {
    canonicalName: null,
    website: null,
    foundingYear: null,
    headquartersAddress: null,
    ceoName: null,
    categories: null,
    confidence: null,
    sources: null,
  };
  for (const k of Object.keys(shape)) if (!(k in obj)) obj[k] = shape[k];
  return obj;
}

// Per-field merge thresholds (LinkedIn: be a bit stricter on CEO/year/HQ than categories)
const FIELD_THRESHOLDS = {
  canonicalName: CFG.min_conf,           // e.g., 0.5
  website:      Math.max(CFG.min_conf, 0.55),
  foundingYear: Math.max(CFG.min_conf, 0.6),
  headquartersAddress: Math.max(CFG.min_conf, 0.6),
  ceoName:      Math.max(CFG.min_conf, 0.7),
  categories:   CFG.min_conf,            // e.g., 0.5
};

function passes(field, conf) {
  if (conf == null) return true; // if model didn’t report a confidence, allow it
  const th = FIELD_THRESHOLDS[field] ?? CFG.min_conf;
  return conf >= th;
}

async function handle(lambdaResponse) {
  const headers = lambdaResponse?.headers || { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const statusCode = lambdaResponse?.statusCode ?? 200;
  const body = typeof lambdaResponse?.body === 'string'
    ? JSON.parse(lambdaResponse.body)
    : (lambdaResponse?.body || lambdaResponse);

  const facts = buildFacts(body);

  // Pre-fill only the safe bit: a canonical-ish name from request/title
  setIfMissing(body, 'name', facts.name);

  // Free-flowing, but with confidence + guardrails
  const system =
    'You are a company metadata normalizer for a LinkedIn company page. ' +
    'Use your world knowledge PLUS the provided LinkedIn OG text. ' +
    'Aim to fill as many fields as reasonably possible. If unsure, provide a best-guess with lower confidence; if you cannot guess, use null. ' +
    'NEVER return a LinkedIn URL as the official website. Do NOT include LinkedIn in sources. ' +
    'Return ONLY valid JSON that matches the schema. No explanations.';

  const userPayload = {
    task: 'Fill company fields from a LinkedIn company URL + OG metadata. Provide best-guess values with an appropriate confidence.',
    inputs: facts,
    required_output_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        canonicalName:       { type: ['string','null'] },
        website:             { type: ['string','null'], description: 'Official homepage (never LinkedIn).' },
        foundingYear:        { type: ['integer','null'], minimum:1600, maximum:2100 },
        headquartersAddress: { type: ['string','null'] },
        ceoName:             { type: ['string','null'] },
        categories:          { type: ['array','null'], items: { type:'string' } },
        confidence:          { type: ['number','null'], minimum: 0, maximum: 1 },
        sources:             { type: ['array','null'], items: { type:'string' } },
      },
      // no "required" list -> let model leave nulls
    },
    rules: [
      'Do not return a LinkedIn URL for website.',
      'Exclude any LinkedIn URLs from sources.',
      'Prefer broad industry categories (e.g., Apparel, Retail, E-commerce).',
      'If you guess a value, lower the confidence accordingly.',
      'Wikipedia and reputable news/business directories are acceptable sources.',
    ],
  };

  const enr = await askOpenAI({ system, userPayload });

  if (enr.ok && enr.data) {
    // sanitize: never LinkedIn website; strip LinkedIn from sources
    if (isLinkedIn(enr.data.website)) enr.data.website = null;
    if (Array.isArray(enr.data.sources)) {
      enr.data.sources = enr.data.sources.filter((s) => s && !isLinkedIn(s));
      if (!enr.data.sources.length) enr.data.sources = null;
    }

    const data = ensureAllKeys(enr.data);
    body.enrichment = data;

    const conf = typeof data.confidence === 'number' ? data.confidence : null;

    // merge non-destructively with per-field thresholds
    if (passes('canonicalName', conf)) setIfMissing(body, 'name', data.canonicalName);
    if (passes('website', conf) && data.website && !isLinkedIn(data.website)) {
      setIfMissing(body, 'website', data.website);
    }
    if (passes('foundingYear', conf)) setIfMissing(body, 'foundingYear', data.foundingYear);
    if (passes('headquartersAddress', conf)) setIfMissing(body, 'headquartersAddress', data.headquartersAddress);
    if (passes('ceoName', conf)) setIfMissing(body, 'ceoName', data.ceoName);
    if (!body.categories && passes('categories', conf) && data.categories) {
      body.categories = data.categories;
    }
  } else {
    // even on failure, provide a normalized enrichment object for frontend parity
    body.enrichment = ensureAllKeys({});
  }

  // extra safety: if something upstream set a LinkedIn site, null it out
  if (isLinkedIn(body.website)) body.website = null;

  const normalized = normalizePreview(body);
  return { statusCode, headers, body: JSON.stringify(normalized) };
}

module.exports = { handle };
