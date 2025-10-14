if (typeof fetch === 'undefined') {
  const { fetch, Headers, Request, Response } = require('undici');
  Object.assign(globalThis, { fetch, Headers, Request, Response });
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

async function withTimeout(promiseFactory, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await promiseFactory(ctrl.signal); }
  finally { clearTimeout(timer); }
}

async function fetchText(url, { headers = {}, timeoutMs = 10000, redirect = 'follow' } = {}) {
  try {
    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          signal,
          redirect,
          headers: { 'User-Agent': UA, ...headers },
        }),
      timeoutMs
    );
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    // Normalize network/abort errors so callers don’t 500
    return { ok: false, status: 0, text: '', error: String(err?.message || err) };
  }
}

module.exports = { withTimeout, fetchText, UA };
