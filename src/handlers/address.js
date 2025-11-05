// src/handlers/address.js
const { ok, bad } = require('../lib/responses');
const { withTimeout } = require('../lib/http');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

/**
 * Map Google Places types to user-friendly categories
 */
function mapTypesToCategories(types = []) {
  const typeMap = {
    clothing_store: 'Clothing',
    shoe_store: 'Footwear',
    department_store: 'Department Store',
    home_goods_store: 'Home Goods',
    furniture_store: 'Furniture',
    jewelry_store: 'Jewelry',
    electronics_store: 'Electronics',
    book_store: 'Books',
    grocery_or_supermarket: 'Grocery',
    convenience_store: 'Convenience Store',
    restaurant: 'Restaurant',
    cafe: 'Cafe',
    bar: 'Bar',
    gym: 'Fitness',
    beauty_salon: 'Beauty',
    hair_care: 'Hair Salon',
    spa: 'Spa',
    store: 'Retail'
  };
  
  const categories = [];
  for (const type of types) {
    const category = typeMap[type];
    if (category && !categories.includes(category)) {
      categories.push(category);
    }
  }
  
  // Limit to 3 most specific categories
  return categories.length ? categories.slice(0, 3) : null;
}

async function handle(payload = {}) {
  if (!API_KEY) {
    return bad(500, 'GOOGLE_PLACES_API_KEY not configured');
  }

  const { address, placeId, name = null } = payload;
  
  try {
    let finalPlaceId = placeId;

    // 1) Find Place by text search
    if (!finalPlaceId) {
      if (!address) {
        return bad(400, 'Provide address or placeId');
      }

      // Try with name+address first if name provided (more specific)
      const query = name ? `${name} ${address}` : address;

      const findUrl = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
      findUrl.searchParams.set('key', API_KEY);
      findUrl.searchParams.set('input', query);
      findUrl.searchParams.set('inputtype', 'textquery');
      findUrl.searchParams.set('fields', 'place_id,name,formatted_address');

      const findRes = await withTimeout((signal) => fetch(findUrl, { signal }), 6000);
      
      if (!findRes.ok) {
        return bad(findRes.status, 'Google Places API request failed');
      }
      
      const findJson = await findRes.json();
      const candidates = findJson.candidates || [];

      if (!candidates.length) {
        // Fallback: if searched with name+address and got nothing, try just address
        if (name && address) {
          const findUrl2 = new URL(findUrl.toString());
          findUrl2.searchParams.set('input', address);
          const findRes2 = await withTimeout((signal) => fetch(findUrl2, { signal }), 6000);
          const findJson2 = await findRes2.json();
          
          if (!findJson2.candidates?.length) {
            return ok({
              kind: 'address',
              request: { name, providedAddress: address },
              place: null
            });
          }
          finalPlaceId = findJson2.candidates[0].place_id;
        } else {
          return ok({
            kind: 'address',
            request: { name, providedAddress: address },
            place: null
          });
        }
      } else {
        // Use first candidate (Google ranks by relevance)
        finalPlaceId = candidates[0].place_id;
      }
    }

    // 2) Get detailed place information
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
    
    if (!detRes.ok) {
      return bad(detRes.status, 'Google Places Details API request failed');
    }
    
    const detJson = await detRes.json();
    const result = detJson.result || null;

    if (!result) {
      return ok({
        kind: 'address',
        request: { name, providedAddress: address },
        place: null
      });
    }

    // Build Google Maps link
    const mapLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(result.formatted_address)}&query_place_id=${result.place_id}`;

    // Build response
    const response = {
      kind: 'address',
      request: {
        name,
        providedAddress: address || null,
        providedPlaceId: placeId || null
      },
      
      // Core place data from Google Places API
      place: {
        name: result.name,
        address: result.formatted_address, // Full street address (kept for maps/directions)
        placeId: result.place_id,
        location: result.geometry?.location || null,
        mapLink,
        
        // Business info
        website: result.website || null,
        phone: result.formatted_phone_number || null,
        categories: mapTypesToCategories(result.types),
        
        // Google-specific data
        gmapsUrl: result.url || null,
        rating: result.rating ?? null,
        reviewsCount: result.user_ratings_total ?? null,
        businessStatus: result.business_status || null,
        hours: result.opening_hours?.weekday_text || null,
        
        // Raw types for reference/debugging
        types: result.types || null
      }
    };

    // Clean up null/undefined values
    Object.keys(response.place).forEach(key => {
      if (response.place[key] === null || response.place[key] === undefined) {
        delete response.place[key];
      }
    });

    return ok(response);
    
  } catch (err) {
    console.error('Address handler error:', err);
    return bad(500, 'Address lookup failed');
  }
}

module.exports = { handle };