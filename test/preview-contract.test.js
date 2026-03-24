const test = require('node:test');
const assert = require('node:assert/strict');

function setIfMissing(obj, key, value) {
  if (
    (obj[key] === undefined || obj[key] === null || obj[key] === '') &&
    value !== undefined &&
    value !== null &&
    value !== ''
  ) {
    obj[key] = value;
  }
}

function withMockedEnrichBase(modulePath, askOpenAI) {
  const enrichBasePath = require.resolve('../src/lib/_enrichBase.js');
  const targetPath = require.resolve(modulePath);

  delete require.cache[enrichBasePath];
  delete require.cache[targetPath];

  require.cache[enrichBasePath] = {
    id: enrichBasePath,
    filename: enrichBasePath,
    loaded: true,
    exports: {
      CFG: { min_conf: 0.5 },
      askOpenAI,
      setIfMissing
    }
  };

  const loaded = require(modulePath);

  delete require.cache[targetPath];
  delete require.cache[enrichBasePath];

  return loaded;
}

test('LinkedIn enrichment still fills canonicalName when it is the only missing field', async () => {
  let askCalls = 0;

  const { handle } = withMockedEnrichBase('../src/lib/enrichLinkedin.js', async () => {
    askCalls += 1;
    return {
      ok: true,
      data: {
        canonicalName: 'Acme Holdings',
        website: null,
        foundingYear: null,
        headquartersAddress: null,
        leaderData: null,
        categories: null,
        confidence: 0.9,
        leaderConfidence: null,
        sources: null
      }
    };
  });

  const response = await handle({
    statusCode: 200,
    body: JSON.stringify({
      kind: 'linkedin',
      request: {
        providedUrl: 'https://www.linkedin.com/company/acme/'
      },
      url: 'https://www.linkedin.com/company/acme/',
      website: 'https://acme.example',
      foundingYear: 2015,
      headquartersAddress: 'Austin, TX',
      categories: ['Retail'],
      meta: {
        description: 'Commerce tools for modern brands'
      }
    })
  });

  const body = JSON.parse(response.body);

  assert.equal(askCalls, 1);
  assert.equal(body.kind, 'linkedin');
  assert.equal(body.name, 'Acme Holdings');
  assert.equal(body.website, 'https://acme.example/');
  assert.deepEqual(body.categories, ['Retail']);
  assert.equal(body.previewOnly.sourceUrl, 'https://www.linkedin.com/company/acme/');
});

test('Address enrichment keeps storefront details preview-only while returning the shared top-level contract', async () => {
  const { handle } = withMockedEnrichBase('../src/lib/enrichAddress.js', async () => ({
    ok: true,
    data: {
      canonicalName: 'Acme Stores',
      shortDescription: 'Neighborhood apparel and gift shop.',
      website: 'https://acme.example',
      foundingYear: 2010,
      headquartersAddress: 'Dallas, TX',
      leaderData: {
        founder: 'Jane Smith'
      },
      categories: ['Retail', 'Apparel'],
      isStorefront: true,
      confidence: 0.85,
      leaderConfidence: 0.8,
      sources: ['https://acme.example/about']
    }
  }));

  const response = await handle({
    statusCode: 200,
    body: JSON.stringify({
      kind: 'address',
      request: {
        name: 'Acme',
        providedAddress: '123 Main St, Austin, TX 78701'
      },
      place: {
        name: 'Acme Downtown',
        address: '123 Main St, Austin, TX 78701',
        phone: '(555) 555-1212',
        categories: ['Clothing'],
        mapLink: 'https://www.google.com/maps/search/?api=1&query=123+Main+St&query_place_id=abc',
        rating: 4.7,
        reviewsCount: 18,
        location: { lat: 30.1, lng: -97.7 }
      }
    })
  });

  const body = JSON.parse(response.body);

  assert.equal(body.kind, 'address');
  assert.equal(body.name, 'Acme');
  assert.equal(body.website, 'https://acme.example/');
  assert.equal(body.shortDescription, 'Neighborhood apparel and gift shop.');
  assert.equal(body.foundingYear, 2010);
  assert.equal(body.headquartersAddress, 'Dallas, TX');
  assert.deepEqual(body.categories, ['Clothing', 'Retail', 'Apparel']);
  assert.equal(body.phone, undefined);
  assert.equal(body.leaderData, undefined);
  assert.equal(body.previewOnly.isStorefront, true);
  assert.equal(body.previewOnly.place.name, 'Acme Downtown');
  assert.equal(body.previewOnly.place.phone, '(555) 555-1212');
  assert.equal(body.previewOnly.leaderData.founder, 'Jane Smith');
  assert.equal(body.previewOnly.dataQuality.hasGooglePlaces, true);
});
