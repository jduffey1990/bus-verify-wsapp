const { ok, bad } = require('../lib/responses');
const { fetchHtmlMeta, decodeEntities, analyzeImage } = require('../lib/meta');
const { normalizeUrl, classifyPath, looksLikeLoginWall } = require('../lib/linkedin');

async function handle({ url }) {
  let normalized;
  try { normalized = normalizeUrl(url); }
  catch { return bad(400, 'Please provide a valid LinkedIn URL'); }

  const { type, slug } = classifyPath(normalized.pathname);
  if (type === 'unknown') {
    return ok({
      kind: 'linkedin',
      url: normalized.toString(),
      type,
      slug: null,
      meta: null,
      limited: true,
      limited_reason: 'unsupported_path',
      favicon: `https://www.google.com/s2/favicons?domain=www.linkedin.com&sz=64`,
    });
  }

  const meta = await fetchHtmlMeta(normalized.toString());
  const raw = meta?._raw || '';
  const title = decodeEntities(meta?.title || '');
  const description = decodeEntities(meta?.description || '');
  const imageDecoded = decodeEntities(meta?.image || '');
  const imgInfo = analyzeImage(imageDecoded);

  const hasAnyOG = !!(title || description || imageDecoded);
  const limited = looksLikeLoginWall(raw) && !hasAnyOG;

  const payload = {
    kind: 'linkedin',
    url: normalized.toString(),
    type, slug,
    meta: {
      ok: !!meta?.ok,
      title, description,
      image: imageDecoded,
      image_host: imgInfo.host,
      image_hotlink_blocked: imgInfo.hotlinkBlocked,
    },
    limited,
    limited_reason: limited ? 'login_wall' : null,
  };

  if (meta && meta._raw) delete meta._raw;
  return ok(payload);
}

module.exports = { handle };
