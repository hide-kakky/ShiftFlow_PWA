// RFC 8291 aes128gcm / RFC 8292 VAPID。Workers標準Web Cryptoだけを使う。
const utf8 = new TextEncoder();
export function encode64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decode64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) throw new Error('invalid_push_key');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  if ((length && bytes.length !== length) || encode64(bytes) !== value) throw new Error('invalid_push_key');
  return bytes;
}
export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
async function hkdf(key, salt, info, length) {
  const material = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, material, length * 8));
}
export function validatePushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) throw new Error('invalid_push_endpoint');
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase();
  // 任意URLへの送信やリダイレクトを許可しない。未対応providerは明示的に追加する。
  const allowed = host === 'web.push.apple.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(host) ||
    host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.pathname === '/') throw new Error('invalid_push_endpoint');
  return url.href;
}
export async function validateSubscription(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid_push_subscription');
  const endpoint = validatePushEndpoint(value.endpoint);
  const p256dh = decode64(value.keys?.p256dh, 65);
  const auth = decode64(value.keys?.auth, 16);
  await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return { endpoint, p256dh: encode64(p256dh), auth: encode64(auth), id: await sha256(endpoint) };
}
export function isPushConfigured(env) {
  try {
    return env?.WEB_PUSH_ENABLED === 'true' && decode64(env.VAPID_PUBLIC_KEY, 65)[0] === 4 &&
      decode64(env.VAPID_PRIVATE_KEY, 32).length === 32 && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(env.VAPID_SUBJECT || '');
  } catch { return false; }
}
export async function encryptPush(subscription, plaintext, options = {}) {
  const receiver = decode64(subscription.p256dh || subscription.keys?.p256dh, 65);
  const auth = decode64(subscription.auth || subscription.keys?.auth, 16);
  const remoteKey = await crypto.subtle.importKey('raw', receiver, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const pair = options.keyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sender = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: remoteKey }, pair.privateKey, 256));
  const ikm = await hkdf(shared, auth, concat(utf8.encode('WebPush: info\0'), receiver, sender), 32);
  const salt = options.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, utf8.encode('Content-Encoding: nonce\0'), 12);
  const bytes = utf8.encode(plaintext);
  if (bytes.length > 3000 || salt.length !== 16) throw new Error('push_payload_too_large');
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(bytes, new Uint8Array([2]))));
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, 4096);
  header[4] = sender.length;
  return concat(salt, header, sender, encrypted);
}
export async function vapidAuthorization(endpoint, env, now = Date.now()) {
  const pub = decode64(env.VAPID_PUBLIC_KEY, 65);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: encode64(pub.slice(1, 33)), y: encode64(pub.slice(33)), d: env.VAPID_PRIVATE_KEY,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = encode64(utf8.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = encode64(utf8.encode(JSON.stringify({ aud: new URL(validatePushEndpoint(endpoint)).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: env.VAPID_SUBJECT })));
  const unsigned = `${head}.${claims}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(unsigned));
  return `vapid t=${unsigned}.${encode64(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}
export async function sendWebPush(subscription, payload, env, options = {}) {
  const endpoint = validatePushEndpoint(subscription.endpoint);
  const body = await encryptPush(subscription, JSON.stringify(payload));
  const authorization = await vapidAuthorization(endpoint, env, options.now);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await (options.fetchImpl || fetch)(endpoint, {
      // Workersはredirect:error未対応。manualで3xxを追わず呼出元で失敗扱いにする。
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: authorization, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'normal' }, body,
    });
    // providerの応答本文にはendpoint等が入り得るため保存/ログ出力しない。
    if (response.body) await response.body.cancel().catch(() => {});
    return response.status;
  } finally { clearTimeout(timeout); }
}
