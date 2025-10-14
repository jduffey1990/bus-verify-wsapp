// index.js
const { ok, bad }    = require('./src/lib/responses');
const website        = require('./src/handlers/website');
const linkedin       = require('./src/handlers/linkedin');
const address        = require('./src/handlers/address');
const enrichURL   = require('./src/lib/enrichURL');
const enrichAddress   = require('./src/lib/enrichAddress');
const enrichLinkedin   = require('./src/lib/enrichLinkedin');

exports.handler = async (event) => {
  try {
    const httpMethod = event?.requestContext?.http?.method;
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        },
        body: '',
      };
    }
    if (httpMethod !== 'POST') return bad(405, 'Method Not Allowed');

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return bad(400, 'Invalid JSON'); }

    const { method, payload = {}, name = null } = body || {};
    if (!method) return bad(400, 'Missing "method"');

    let baseRes;
    let finalRes
    if (method === 'website') {
      if (!payload?.url) return bad(400, 'Missing payload.url');
      // pass name down so handler can echo it for correlation
      baseRes = await website.handle({ ...payload, name });
      finalRes = await enrichURL.handle(baseRes);
      return finalRes;
    } else if (method === 'linkedin') {
      if (!payload?.url) return bad(400, 'Missing payload.url');
      baseRes = await linkedin.handle({ ...payload, name });
      finalRes = await enrichLinkedin.handle(baseRes);
      return finalRes;
    } else if (method === 'address') {
      baseRes = await address.handle({ ...payload, name });
      finalRes = await enrichAddress.handle(baseRes);
      return finalRes;
    } else {
      return bad(400, `Unknown method "${method}"`);
    }


  } catch (err) {
    console.error('fatal', { msg: err?.message, stack: err?.stack });
    return bad(500, 'Internal error');
  }
};

