// src/lib/enrichURL.js
const { askOpenAI, setIfMissing, CFG } = require('./_enrichBase');
const { normalizePreview } = require('./previewNormalize');

function hostnameOf(u) {
  try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return null; }
}

function buildFacts(body) {
  const name = body?.request?.name
    || body?.structured?.name
    || body?.meta?.title
    || null;

  const sourceUrl = body?.url || body?.structured?.url || null; // the page we actually fetched
  const website = body?.structured?.url || body?.url || null;   // candidate official site (usually same)
  const og = body?.meta || {};
  const jsonld = body?.structured || null; // ok if null

  return {
    name,
    website,
    og,
    jsonld,
    providedSources: [sourceUrl].filter(Boolean) // inform model not to cite it
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

  // Pre-fill from what we already know
  setIfMissing(body, 'name', facts.name);
  setIfMissing(body, 'website', facts.website);
  setIfMissing(body, 'shortDescription', facts?.og?.description || null);

  const system =
    'You are a company metadata normalizer for a brand homepage. ' +
    'Aim to fill as many fields as reasonably possible using your world knowledge PLUS the provided OG/JSON-LD. ' +
    'If you are unsure, you may still provide a best-guess but set a lower confidence; if you cannot guess, use null. ' +
    'Return ONLY valid JSON that matches the schema. No explanations. ' +
    'Do not cite any URL that was provided in inputs as a source.';

  const userPayload = {
    task: 'Fill company fields from a homepage URL and OG/JSON-LD cues. Provide best-guess values with an appropriate confidence.',
    inputs: facts,
    required_output_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        canonicalName:       { type: ['string','null'] },
        shortDescription:    { type: ['string','null'] },
        website:             { type: ['string','null'] },
        foundingYear:        { type: ['integer','null'], minimum:1600, maximum:2100 },
        headquartersAddress: { type: ['string','null'] },
        ceoName:             { type: ['string','null'] },
        categories:          { type: ['array','null'], items: { type:'string' } },
        // single overall confidence is fine for your UI; model can scale 0–1
        confidence:          { type: ['number','null'], minimum: 0, maximum: 1 },
        sources:             { type: ['array','null'], items: { type:'string' } }
      },
      // no hard "required" list — let it leave some nulls if needed
    },
    rules: [
      'Do not include any providedSources in sources; if no additional sources are applicable, return null for sources.',
      'Use broad industry categories (e.g., Apparel, Retail, E-commerce).',
      'If you guess a value, lower confidence accordingly (e.g., 0.3–0.7).'
    ]
  };

  const enr = await askOpenAI({ system, userPayload });

  if (enr.ok && enr.data) {
    // sanitize sources: remove provided source host & duplicates
    const providedHosts = (facts.providedSources || []).map(hostnameOf).filter(Boolean);
    if (Array.isArray(enr.data.sources)) {
      const seen = new Set();
      enr.data.sources = enr.data.sources.filter((s) => {
        const h = hostnameOf(s);
        if (!s || !h) return false;
        if (providedHosts.includes(h)) return false; // drop "the same site we gave you"
        if (seen.has(h)) return false;               // de-dupe by host
        seen.add(h);
        return true;
      });
      if (!enr.data.sources.length) enr.data.sources = null;
    }

    const conf = typeof enr.data.confidence === 'number' ? enr.data.confidence : null;
    const highEnough = conf === null ? true : conf >= CFG.min_conf;

    // attach raw enrichment for UI/telemetry
    body.enrichment = enr.data;

    // merge (non-destructive) — use the tunable threshold
    if (highEnough) {
      setIfMissing(body, 'name', enr.data.canonicalName);
      setIfMissing(body, 'website', enr.data.website);
      if (!body.shortDescription) setIfMissing(body, 'shortDescription', enr.data.shortDescription);
      setIfMissing(body, 'foundingYear', enr.data.foundingYear);
      setIfMissing(body, 'headquartersAddress', enr.data.headquartersAddress);
      setIfMissing(body, 'ceoName', enr.data.ceoName);
      if (!body.categories && enr.data.categories) body.categories = enr.data.categories;
    }
  }

  const normalized = normalizePreview(body);
  return { statusCode, headers, body: JSON.stringify(normalized) };

}

module.exports = { handle };
