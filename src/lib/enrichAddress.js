// src/lib/enrichAddress.js
const { askOpenAI, setIfMissing, CFG } = require('./_enrichBase');
const { normalizePreview } = require('./previewNormalize');

const TYPE_TO_CATEGORY = {
  clothing_store: 'Clothing',
  shoe_store: 'Footwear',
  department_store: 'Department Store',
  home_goods_store: 'Home Goods',
  furniture_store: 'Furniture',
  store: 'Retail',
  point_of_interest: null,
  establishment: null
};

function mapTypes(types = []) {
  const out = [];
  for (const t of types) {
    const cat = TYPE_TO_CATEGORY[t];
    if (cat && !out.includes(cat)) out.push(cat);
  }
  return out.length ? out : null;
}

function hostnameOf(u) {
  try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return null; }
}

function buildFacts(body) {
  const p = body?.place || {};
  const providedSources = [];
  if (body?.mapLink) providedSources.push(body.mapLink);
  if (p?.gmapsUrl) providedSources.push(p.gmapsUrl);
  if (p?.address) providedSources.push(p.address);

  return {
    name: body?.request?.name || p?.name || null,
    address: p?.address || null,
    website: p?.website || null,               // store/brand website if Places provides it
    gmapsUrl: p?.gmapsUrl || body?.mapLink || null,
    categoriesFromTypes: mapTypes(p?.types || []),
    phone: p?.phone || null,
    geo: p?.location || null,
    providedSources
  };
}

// non-destructive local merge using deterministic (Places) fields
function mergeDeterministic(body, facts) {
  setIfMissing(body, 'name', facts.name);
  setIfMissing(body, 'website', facts.website);
  setIfMissing(body, 'headquartersAddress', facts.address);
  if (!body.categories && facts.categoriesFromTypes) body.categories = facts.categoriesFromTypes;
  if (!body.phone && facts.phone) body.phone = facts.phone;
}

// per-field thresholds (more permissive for categories/description than CEO/year)
const FIELD_THRESHOLDS = {
  canonicalName: CFG.min_conf,          // e.g., 0.5
  shortDescription: CFG.min_conf,       // e.g., 0.5
  website: CFG.min_conf,                // e.g., 0.5
  headquartersAddress: Math.max(CFG.min_conf, 0.6),
  foundingYear: Math.max(CFG.min_conf, 0.6),
  ceoName: Math.max(CFG.min_conf, 0.7),
  categories: CFG.min_conf             // e.g., 0.5
};

function passes(field, conf) {
  if (conf == null) return true; // if model didn’t return a confidence, allow merge
  const th = FIELD_THRESHOLDS[field] ?? CFG.min_conf;
  return conf >= th;
}

function ensureAllKeys(obj) {
  const shape = {
    canonicalName: null,
    shortDescription: null,
    website: null,
    foundingYear: null,
    headquartersAddress: null,
    ceoName: null,
    categories: null,
    confidence: null,
    sources: null
  };
  for (const k of Object.keys(shape)) if (!(k in obj)) obj[k] = shape[k];
  return obj;
}

async function handle(lambdaResponse) {
  const headers = lambdaResponse?.headers || { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const statusCode = lambdaResponse?.statusCode ?? 200;
  const body = typeof lambdaResponse?.body === 'string' ? JSON.parse(lambdaResponse.body) : (lambdaResponse?.body || lambdaResponse);

  const facts = buildFacts(body);
  mergeDeterministic(body, facts);

  // Always allow GPT here (visual/exploratory). It may polish categories/description and
  // can guess brand-level details when this is a single storefront of a bigger brand.
  const system =
    'You are a company/location metadata normalizer for a specific physical address. ' +
    'Aim to fill as many fields as reasonably possible using your world knowledge PLUS the provided address/Places cues. ' +
    'If unsure, you may provide a best-guess with a lower confidence; if you cannot guess, return null. ' +
    'Return ONLY valid JSON that matches the schema. No explanations. ' +
    'Do not cite the provided Google Maps URL or the input address as a source.';

  const userPayload = {
    task: 'Fill company/location fields given a store address (may be a single storefront of a larger brand). Provide best-guess values with an appropriate confidence.',
    inputs: facts,
    required_output_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        canonicalName:       { type: ['string','null'] },  // brand or store name
        shortDescription:    { type: ['string','null'] },  // 1 sentence neutral summary
        website:             { type: ['string','null'] },  // brand or store site
        foundingYear:        { type: ['integer','null'], minimum:1600, maximum:2100 },
        headquartersAddress: { type: ['string','null'] },  // HQ (brand-level) if known
        ceoName:             { type: ['string','null'] },  // brand CEO if known
        categories:          { type: ['array','null'], items: { type:'string' } },
        confidence:          { type: ['number','null'], minimum: 0, maximum: 1 },
        sources:             { type: ['array','null'], items: { type:'string' } }
      }
      // no hard "required" list; let model leave nulls if needed
    },
    rules: [
      'If this is a storefront of a larger brand, you may return the brand canonicalName and website if reasonably confident.',
      'Use broad industry/retail categories (e.g., Apparel, Retail, E-commerce).',
      'If you guess a value, lower the confidence accordingly (e.g., 0.3–0.7).',
      'Do not include Google Maps URLs or the exact input address in sources.'
    ]
  };

  const enr = await askOpenAI({ system, userPayload });

  if (enr.ok && enr.data) {
    // sanitize sources: drop provided address/gmaps host & duplicates
    const providedHosts = (facts.providedSources || []).map(hostnameOf).filter(Boolean);
    if (Array.isArray(enr.data.sources)) {
      const seen = new Set();
      enr.data.sources = enr.data.sources.filter((s) => {
        if (!s) return false;
        const h = hostnameOf(s);
        // discard exact address strings or the same host as provided sources (e.g., google.com/maps)
        if (!h) {
          // a plain string that isn't a URL (e.g., the address): reject
          return false;
        }
        if (providedHosts.includes(h)) return false;
        if (seen.has(h)) return false;
        seen.add(h);
        return true;
      });
      if (!enr.data.sources.length) enr.data.sources = null;
    }

    // ensure shape is complete for the frontend (even if nulls)
    const data = ensureAllKeys(enr.data);
    body.enrichment = data;

    // single overall confidence (if present) used as a baseline
    const conf = typeof data.confidence === 'number' ? data.confidence : null;

    // merge non-destructively with per-field thresholds
    if (passes('canonicalName', conf)) setIfMissing(body, 'name', data.canonicalName);
    if (passes('website', conf)) setIfMissing(body, 'website', data.website);
    if (!body.shortDescription && passes('shortDescription', conf)) {
      setIfMissing(body, 'shortDescription', data.shortDescription);
    }
    if (passes('headquartersAddress', conf)) setIfMissing(body, 'headquartersAddress', data.headquartersAddress);
    if (passes('foundingYear', conf)) setIfMissing(body, 'foundingYear', data.foundingYear);
    if (passes('ceoName', conf)) setIfMissing(body, 'ceoName', data.ceoName);
    if (!body.categories && passes('categories', conf) && data.categories) {
      body.categories = data.categories;
    }
  } else {
    // even if model call failed, normalize enrichment payload for frontend parity
    body.enrichment = ensureAllKeys({});
  }

  const normalized = normalizePreview(body);
  return { statusCode, headers, body: JSON.stringify(normalized) };
}

module.exports = { handle };
