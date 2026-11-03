/** Shared response-shape helpers for the per-channel client API modules. */

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value, fallback, max = 240) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

export function id(value) {
  const result = text(value, '', 128);
  return /^[a-z\d_-]+$/i.test(result) ? result : undefined;
}

export const QR_DATA_URL = /^data:image\/(?:png|webp);base64,[a-z\d+/]+={0,2}$/i;

export function safeQrSource(value) {
  return typeof value === 'string' && value.length <= 2 * 1024 * 1024 && QR_DATA_URL.test(value)
    ? value : undefined;
}
