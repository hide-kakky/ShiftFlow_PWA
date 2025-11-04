export function resolveCallbackUrl(origin, config) {
  const bases = Array.isArray(config?.allowedOrigins) ? config.allowedOrigins : [];
  const trimmedOrigin = typeof origin === 'string' ? origin.trim() : '';
  const candidate =
    trimmedOrigin && bases.includes(trimmedOrigin) ? trimmedOrigin : bases[0] || trimmedOrigin;
  const normalized = (candidate || '').replace(/\/+$/, '');
  if (!normalized) return '/auth/callback';
  return `${normalized}/auth/callback`;
}
