function normalizeUrl(input) {
    const u = new URL(input);
    if (!/linkedin\.com$/i.test(u.hostname) && !/\.linkedin\.com$/i.test(u.hostname)) {
      throw new Error('Not a LinkedIn domain');
    }
    const path = u.pathname.replace(/\/+$/, '');
    return new URL(`https://www.linkedin.com${path || '/'}`);
  }
  
  function classifyPath(pathname = '') {
    if (/^\/company\/[^/]+$/i.test(pathname)) return { type: 'company', slug: pathname.split('/')[2] };
    if (/^\/school\/[^/]+$/i.test(pathname))  return { type: 'school',  slug: pathname.split('/')[2] };
    if (/^\/in\/[^/]+$/i.test(pathname))      return { type: 'person',  slug: pathname.split('/')[2] };
    if (/^\/showcase\/[^/]+$/i.test(pathname))return { type: 'showcase',slug: pathname.split('/')[2] };
    return { type: 'unknown', slug: '' };
  }
  
  function looksLikeLoginWall(html = '') {
    return (
      /www\.linkedin\.com\/uas\/login/i.test(html) ||
      /<form[^>]+action="\/uas\/login/i.test(html) ||
      />Sign in to LinkedIn</i.test(html) ||
      />You[’']re signed out</i.test(html) ||
      /"showJoinForm"\s*:\s*true/i.test(html)
    );
  }
  
  module.exports = { normalizeUrl, classifyPath, looksLikeLoginWall };
  