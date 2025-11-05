const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_SECONDS = 120;

let cachedJwks = null;
let cachedJwksExpiry = 0;

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  const binary = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtSection(section) {
  const textDecoder = new TextDecoder();
  return textDecoder.decode(base64UrlDecode(section));
}

function parseJwt(token) {
  if (typeof token !== 'string') {
    throw new Error('ID token is not a string.');
  }
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new Error('ID token must have three segments.');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  let header;
  let payload;
  try {
    header = JSON.parse(decodeJwtSection(encodedHeader));
  } catch (err) {
    throw new Error('Failed to parse ID token header.');
  }
  try {
    payload = JSON.parse(decodeJwtSection(encodedPayload));
  } catch (err) {
    throw new Error('Failed to parse ID token payload.');
  }
  const signature = base64UrlDecode(encodedSignature);
  return {
    header,
    payload,
    signature,
    signedPortion: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  };
}

async function fetchJwks() {
  if (cachedJwks && cachedJwksExpiry > Date.now()) {
    return cachedJwks;
  }
  const response = await fetch(JWKS_URI, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Failed to fetch Google JWKS (${response.status})`);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.keys)) {
    throw new Error('JWKS endpoint returned an invalid payload.');
  }
  cachedJwks = {};
  body.keys.forEach((jwk) => {
    if (jwk && jwk.kid) {
      cachedJwks[jwk.kid] = jwk;
    }
  });
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const ttlSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 300;
  cachedJwksExpiry = Date.now() + ttlSeconds * 1000;
  return cachedJwks;
}

async function verifyWithJwks(idToken, clientId) {
  const parsed = parseJwt(idToken);
  if (!parsed.header.kid) {
    throw new Error('ID token is missing key id (kid).');
  }
  const jwks = await fetchJwks();
  const jwk = jwks[parsed.header.kid];
  if (!jwk) {
    throw new Error('Signing key not found for ID token.');
  }
  if (!jwk.alg || jwk.alg !== 'RS256') {
    throw new Error('Unsupported signing algorithm.');
  }
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify']
  );
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    parsed.signature,
    parsed.signedPortion
  );
  if (!verified) {
    throw new Error('ID token signature verification failed.');
  }
  if (!parsed.payload || typeof parsed.payload !== 'object') {
    throw new Error('ID token payload is invalid.');
  }
  if (!parsed.payload.aud) {
    throw new Error('ID token payload is missing audience.');
  }
  if (parsed.payload.aud !== clientId) {
    throw new Error('ID token audience mismatch.');
  }
  if (!parsed.payload.iss || !GOOGLE_ISSUERS.has(String(parsed.payload.iss))) {
    throw new Error('ID token issuer is not Google.');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = Number(parsed.payload.exp || 0);
  if (expSeconds && nowSeconds - CLOCK_SKEW_SECONDS >= expSeconds) {
    throw new Error('ID token has expired.');
  }
  const iatSeconds = Number(parsed.payload.iat || 0);
  if (iatSeconds && iatSeconds > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error('ID token was issued in the future.');
  }
  const nbfSeconds = Number(parsed.payload.nbf || 0);
  if (nbfSeconds && nowSeconds + CLOCK_SKEW_SECONDS < nbfSeconds) {
    throw new Error('ID token is not yet valid.');
  }
  if (!parsed.payload.sub) {
    throw new Error('ID token is missing subject (sub).');
  }
  if (!parsed.payload.email) {
    throw new Error('ID token is missing email.');
  }
  const emailVerifiedRaw = parsed.payload.email_verified;
  const emailVerified =
    emailVerifiedRaw === true ||
    emailVerifiedRaw === 'true' ||
    emailVerifiedRaw === 1 ||
    emailVerifiedRaw === '1';
  return {
    rawToken: idToken,
    sub: String(parsed.payload.sub),
    email: String(parsed.payload.email),
    emailVerified,
    name: parsed.payload.name || parsed.payload.given_name || '',
    picture: parsed.payload.picture || '',
    hd: parsed.payload.hd || '',
    aud: parsed.payload.aud,
    iss: parsed.payload.iss,
    iat: Number(parsed.payload.iat || 0),
    exp: Number(parsed.payload.exp || 0),
  };
}

async function verifyViaTokenInfo(idToken, clientId) {
  const tokenUrl = `${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`;
  const response = await fetch(tokenUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Token verification failed (HTTP ${response.status})`);
  }
  let data;
  try {
    data = await response.json();
  } catch (_err) {
    throw new Error('Token verification returned a non-JSON response.');
  }

  if (!data || !data.aud || String(data.aud) !== clientId) {
    throw new Error('ID token audience mismatch.');
  }
  if (!GOOGLE_ISSUERS.has(String(data.iss || ''))) {
    throw new Error('ID token issuer is not Google.');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = Number(data.exp || 0);
  if (expSeconds && nowSeconds - CLOCK_SKEW_SECONDS >= expSeconds) {
    throw new Error('ID token has expired.');
  }
  const iatSeconds = Number(data.iat || 0);
  if (iatSeconds && iatSeconds > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error('ID token was issued in the future.');
  }
  const nbfSeconds = Number(data.nbf || 0);
  if (nbfSeconds && nowSeconds + CLOCK_SKEW_SECONDS < nbfSeconds) {
    throw new Error('ID token is not yet valid.');
  }
  const sub = String(data.sub || '').trim();
  if (!sub) {
    throw new Error('ID token is missing subject (sub).');
  }
  const email = String(data.email || '').trim();
  if (!email) {
    throw new Error('ID token is missing email.');
  }
  const emailVerifiedRaw = data.email_verified;
  const emailVerified =
    emailVerifiedRaw === true ||
    emailVerifiedRaw === 'true' ||
    emailVerifiedRaw === 1 ||
    emailVerifiedRaw === '1';
  return {
    rawToken: idToken,
    sub,
    email,
    emailVerified,
    name: data.name || data.given_name || '',
    picture: data.picture || '',
    hd: data.hd || '',
    aud: data.aud,
    iss: data.iss,
    iat: Number(data.iat || 0),
    exp: expSeconds,
  };
}

export async function verifyGoogleIdToken(env, config, idToken) {
  if (!idToken) {
    throw new Error('Missing ID token.');
  }
  const googleClientId = config.googleClientId;
  if (!googleClientId) {
    throw new Error('Google OAuth client id is not configured.');
  }
  const useJwks = !!(config.flags && config.flags.useJwks);
  if (useJwks) {
    try {
      return await verifyWithJwks(idToken, googleClientId);
    } catch (err) {
      console.warn('[ShiftFlow][Auth] JWKS verification failed; falling back to tokeninfo', err);
      return verifyViaTokenInfo(idToken, googleClientId);
    }
  }
  return verifyViaTokenInfo(idToken, googleClientId);
}
