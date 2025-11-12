const CANONICAL_DOMAIN = 'shiftflow.pages.dev';

function isAllowedHostname(hostname) {
  if (!hostname) return false;
  if (hostname === CANONICAL_DOMAIN) return true;
  return hostname.endsWith(`.${CANONICAL_DOMAIN}`);
}

function normalizeTarget(rawValue) {
  if (!rawValue) return null;
  try {
    const targetUrl = new URL(rawValue, `https://${CANONICAL_DOMAIN}`);
    if (targetUrl.protocol !== 'https:') {
      return null;
    }
    if (!isAllowedHostname(targetUrl.hostname)) {
      return null;
    }
    return targetUrl.toString();
  } catch (_err) {
    return null;
  }
}

export async function onRequest({ request }) {
  const requestUrl = new URL(request.url);
  let target = requestUrl.searchParams.get('target') || '';
  if (!target && request.method === 'POST') {
    try {
      const contentType = request.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const body = await request.clone().json();
        if (body && typeof body.target === 'string') {
          target = body.target;
        }
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const form = await request.clone().formData();
        target = form.get('target') || '';
      }
    } catch (_err) {
      target = '';
    }
  }

  const normalizedTarget = normalizeTarget(target);
  if (!normalizedTarget) {
    return new Response('Invalid relay target', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: normalizedTarget,
      'Cache-Control': 'no-store',
    },
  });
}
