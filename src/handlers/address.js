// src/handlers/address.js
const { ok, bad } = require('../lib/responses');
const { withTimeout } = require('../lib/http');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

async function handle(payload = {}) {
  if (!API_KEY) return bad(500, 'GOOGLE_PLACES_API_KEY not configured');

  const { address, placeId, name = null } = payload;
  try {
    let finalPlaceId = placeId;

    // 1) Find Place by text — prefer "NAME ADDRESS" if name present
    if (!finalPlaceId) {
      if (!address) return bad(400, 'Provide address or placeId');

      const query = name ? `${name} ${address}` : address;

      const findUrl = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
      findUrl.searchParams.set('key', API_KEY);
      findUrl.searchParams.set('input', query);
      findUrl.searchParams.set('inputtype', 'textquery');
      // Pull back a little more to help choose the right candidate if Google returns multiple
      findUrl.searchParams.set('fields', 'place_id,name,formatted_address');

      const findRes = await withTimeout((signal) => fetch(findUrl, { signal }), 6000);
      const findJson = await findRes.json();
      const candidates = findJson.candidates || [];

      if (!candidates.length) {
        // Fallback: if we searched with name+address and got nothing, try just address once
        if (name && address) {
          const findUrl2 = new URL(findUrl);
          findUrl2.searchParams.set('input', address);
          const findRes2 = await withTimeout((signal) => fetch(findUrl2, { signal }), 6000);
          const findJson2 = await findRes2.json();
          if (!findJson2.candidates?.length) {
            return ok({ kind: 'address', request: { name }, query: address, place: null });
          }
          finalPlaceId = findJson2.candidates[0].place_id;
        } else {
          return ok({ kind: 'address', request: { name }, query: address, place: null });
        }
      } else {
        // simple pick: first candidate (could add fuzzy match to prefer names that include the provided name)
        finalPlaceId = candidates[0].place_id;
      }
    }

    // 2) Details for the place — ask for richer fields
    const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    detailsUrl.searchParams.set('key', API_KEY);
    detailsUrl.searchParams.set('place_id', finalPlaceId);
    detailsUrl.searchParams.set('fields', [
      'name',
      'formatted_address',
      'geometry/location',
      'place_id',
      'website',
      'types',
      'formatted_phone_number',
      'url',
      'rating',
      'user_ratings_total',
      'business_status',
      'opening_hours/weekday_text'
    ].join(','));

    const detRes = await withTimeout((signal) => fetch(detailsUrl, { signal }), 6000);
    const detJson = await detRes.json();
    const result = detJson.result || null;

    const mapTypesToCategories = (types = []) => {
      const map = {
        clothing_store: 'Clothing',
        shoe_store: 'Footwear',
        department_store: 'Department Store',
        home_goods_store: 'Home Goods',
        furniture_store: 'Furniture',
        store: 'Retail',
        point_of_interest: null,
        establishment: null
      };
      const cats = [];
      for (const t of types) if (map[t] && !cats.includes(map[t])) cats.push(map[t]);
      return cats.length ? cats : null;
    };

    const mapLink = result
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(result.formatted_address)}&query_place_id=${result.place_id}`
      : null;

    return ok({
      kind: 'address',
      request: { name },                // <-- echo back provided name so enrichers can use it
      query: address || null,
      place: result ? {
        name: result.name,
        address: result.formatted_address,
        placeId: result.place_id,
        location: result.geometry?.location || null,
        mapLink,
        website: result.website || null,
        categories: mapTypesToCategories(result.types || []),
        phone: result.formatted_phone_number || null,
        gmapsUrl: result.url || null,
        rating: result.rating ?? null,
        reviewsCount: result.user_ratings_total ?? null,
        status: result.business_status || null,
        hours: result.opening_hours?.weekday_text || null
      } : null
    });
  } catch (err) {
    console.error('address error', err);
    return bad(500, 'Address preview failed');
  }
}

module.exports = { handle };
