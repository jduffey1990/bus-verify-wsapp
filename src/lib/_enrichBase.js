// src/lib/_enrichBase.js
if (typeof fetch === 'undefined') {
  const { fetch, Headers, Request, Response } = require('undici');
  Object.assign(globalThis, { fetch, Headers, Request, Response });
}

const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.GPT_MODEL || 'gpt-4o-mini'; // use a stronger model for enrichment
const API_KEY = process.env.GPT_API_KEY;

// Tuning knobs (with sane defaults for "free-flowing" mode)
const CFG = {
  temperature: Number(process.env.GPT_TEMPERATURE ?? 0.5), // more creative
  top_p:       Number(process.env.GPT_TOP_P ?? 1),
  // set your global minimum merge confidence (0.3–0.6 feels good for visuals)
  min_conf:    Number(process.env.MIN_MERGE_CONFIDENCE ?? 0.5),
  // deterministic seed (integer). Leave unset to allow variability.
  seed:        process.env.GPT_SEED ? parseInt(process.env.GPT_SEED, 10) : undefined,
};

function setIfMissing(target, key, value) {
  const existing = target?.[key];
  const isMissing = existing === undefined || existing === null || existing === '';
  if (isMissing && value !== undefined) target[key] = value;
}

async function askOpenAI({ system, userPayload, modelOverride }) {
  if (!API_KEY) return { ok: false, reason: 'no_api_key' };

  const payload = {
    model: modelOverride || MODEL,
    temperature: CFG.temperature,
    top_p: CFG.top_p,
    ...(CFG.seed !== undefined ? { seed: CFG.seed } : {}),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  };

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('openai error', res.status, text?.slice(0, 400));
      return { ok: false, reason: `http_${res.status}` };
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, reason: 'no_content' };
    let data;
    try { data = JSON.parse(content); } catch (e) {
      console.error('openai json parse fail', e?.message || e, content?.slice(0, 160));
      return { ok: false, reason: 'bad_json' };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('openai request failed', err?.message || err);
    return { ok: false, reason: 'exception' };
  }
}

module.exports = { askOpenAI, setIfMissing, CFG };
