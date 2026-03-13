import { createHmac, timingSafeEqual } from "node:crypto";

export function generateSubtitleToken(
  secret: string,
  subtitleId: string,
  mediaId: string,
): { token: string; expires: number } {
  const expires = Date.now() + 300_000; // 5 minutes
  const data = `${subtitleId}:${mediaId}:${expires}`;
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  return { token: `${signature}:${expires}`, expires };
}

export function validateSubtitleToken(
  secret: string,
  subtitleId: string,
  mediaId: string,
  token: string,
): boolean {
  const sepIndex = token.lastIndexOf(":");
  if (sepIndex === -1) return false;
  const signature = token.slice(0, sepIndex);
  const expiresStr = token.slice(sepIndex + 1);
  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || Date.now() > expires) return false;
  const data = `${subtitleId}:${mediaId}:${expires}`;
  const expected = createHmac("sha256", secret).update(data).digest("hex");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
