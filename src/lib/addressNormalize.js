// src/lib/addressNormalize.js

/**
 * Parse a full address and extract components
 */
function parseAddress(address) {
  if (!address || typeof address !== 'string') return null;
  
  const cleaned = address.trim();
  
  // Common patterns to extract city, state, country
  const patterns = [
    // US format: "123 Street, City, ST 12345"
    /(?:.*,\s*)?([^,]+),\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?(?:,\s*(.+))?$/i,
    
    // US format without zip: "123 Street, City, ST"
    /(?:.*,\s*)?([^,]+),\s*([A-Z]{2})(?:,\s*(.+))?$/i,
    
    // City, State: "San Francisco, California"
    /^([^,]+),\s*([^,]+)(?:,\s*(.+))?$/,
    
    // City, State, Country: "San Francisco, CA, USA"
    /^([^,]+),\s*([^,]+),\s*(.+)$/,
    
    // Just City: "San Francisco"
    /^([^,]+)$/
  ];
  
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const [, city, stateOrCountry, country] = match;
      
      // Determine if we have state or went straight to country
      const hasState = stateOrCountry && (
        stateOrCountry.length === 2 || // Two-letter state code
        isUSState(stateOrCountry) ||    // Full state name
        !country                        // If no country, assume it's state
      );
      
      return {
        city: city?.trim() || null,
        state: hasState ? stateOrCountry?.trim() : null,
        country: country?.trim() || (hasState ? null : stateOrCountry?.trim())
      };
    }
  }
  
  // Fallback: treat entire string as city
  return {
    city: cleaned,
    state: null,
    country: null
  };
}

/**
 * Check if string is a US state (full name or abbreviation)
 */
function isUSState(str) {
  if (!str) return false;
  
  const states = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
    'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
    'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana',
    'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
    'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
    'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
    'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
    'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming'
  ];
  
  return states.some(state => 
    state.toLowerCase() === str.toLowerCase()
  );
}

/**
 * Normalize state names to abbreviations
 */
function normalizeState(state) {
  if (!state) return null;
  
  // If already 2 letters, uppercase and return
  if (state.length === 2) {
    return state.toUpperCase();
  }
  
  // Map full names to abbreviations
  const stateMap = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN',
    'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE',
    'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
    'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR',
    'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
    'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY'
  };
  
  return stateMap[state.toLowerCase()] || state;
}

/**
 * Normalize country names
 */
function normalizeCountry(country) {
  if (!country) return null;
  
  const countryMap = {
    'usa': 'United States',
    'us': 'United States',
    'united states of america': 'United States',
    'u.s.a.': 'United States',
    'u.s.': 'United States',
    'uk': 'United Kingdom',
    'u.k.': 'United Kingdom',
    'great britain': 'United Kingdom',
    'england': 'United Kingdom'
  };
  
  const normalized = countryMap[country.toLowerCase()];
  if (normalized) return normalized;
  
  // Capitalize first letter of each word
  return country
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Normalize address to consistent format: "City, State, Country"
 * Rules:
 * - Always include city
 * - Include state if available and country is US
 * - Include country if available and not US
 * - US addresses: "City, ST" (no country)
 * - International: "City, Country" (no state unless meaningful)
 */
function normalizeAddress(address) {
  if (!address || typeof address !== 'string') return null;
  
  const parsed = parseAddress(address);
  if (!parsed || !parsed.city) return null;
  
  const { city, state, country } = parsed;
  
  // Normalize components
  const normalizedState = normalizeState(state);
  const normalizedCountry = normalizeCountry(country);
  
  // Determine if this is a US address
  const isUS = 
    normalizedCountry === 'United States' ||
    normalizedCountry === 'USA' ||
    (!normalizedCountry && normalizedState); // If we have state but no country, assume US
  
  // Build normalized address
  const parts = [city];
  
  if (isUS && normalizedState) {
    // US format: "City, ST"
    parts.push(normalizedState);
  } else if (normalizedCountry && normalizedCountry !== 'United States') {
    // International format: "City, Country"
    parts.push(normalizedCountry);
  } else if (normalizedState && !isUS) {
    // Has state but not US (rare, but handle it)
    parts.push(normalizedState);
    if (normalizedCountry) parts.push(normalizedCountry);
  }
  
  return parts.join(', ');
}

/**
 * Normalize address specifically for headquarters field
 * Can also provide full address separately if needed
 */
function normalizeHeadquarters(address) {
  const normalized = normalizeAddress(address);
  
  return {
    headquartersAddress: normalized,
    // Optionally keep full address for reference
    fullAddress: address
  };
}

module.exports = {
  normalizeAddress,
  normalizeHeadquarters,
  parseAddress
};