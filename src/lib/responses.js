const JSON_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // TODO: restrict
  };
  
  const ok = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });
  const bad = (code, message, extra = {}) => ({
    statusCode: code,
    headers: JSON_HEADERS,
    body: JSON.stringify({ error: message, ...extra }),
  });
  
  module.exports = { ok, bad, JSON_HEADERS };
  