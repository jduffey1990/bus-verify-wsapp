// devServer.js
const express = require('express');
const app = express();
const PORT = process.env.PORT || 4001;

// import your Lambda handler:
const { handler } = require('./index'); // change path if your handler file isn't index.js

app.use(express.json({ type: ['application/json', 'text/plain'] })); // handle JSON body

// CORS (dev-friendly)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten later
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Convert an Express req into an API Gateway HTTP API v2 event
function toApiGwEvent(req) {
  const bodyString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  return {
    version: '2.0',
    routeKey: `${req.method} ${req.path}`,
    rawPath: req.path,
    rawQueryString: new URLSearchParams(req.query).toString(),
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])
    ),
    requestContext: {
      http: {
        method: req.method,
        path: req.path,
        protocol: 'HTTP/1.1',
        sourceIp: req.ip || '127.0.0.1',
        userAgent: req.headers['user-agent'] || ''
      }
    },
    body: bodyString || '',
    isBase64Encoded: false
  };
}

// Your local endpoint that mirrors API Gateway route
app.post('/verify', async (req, res) => {
  try {
    const event = toApiGwEvent(req);
    const result = await handler(event, {}); // context is {}
    // result: { statusCode, headers, body }
    res.status(result.statusCode || 200);
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    }
    // Return the Lambda body as-is
    return res.send(result.body ?? '');
  } catch (err) {
    console.error('Local server error:', err);
    return res.status(500).json({ error: 'local_server_error', detail: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Local Lambda wrapper listening on http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/verify`);
});
