import crypto from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';

function isPrivateV4(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/**
 * The address a phone on the same network can reach. Looked up on every call:
 * a laptop's address changes when it moves between networks.
 */
export function lanAddress(interfaces = os.networkInterfaces()): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      if (/^(utun|awdl|llw|bridge|docker|veth|vmnet|vboxnet|tun|tap)/i.test(name)) continue;
      candidates.push({ name, address: i.address });
    }
  }
  const preferred =
    candidates.find((c) => isPrivateV4(c.address) && /^(en|wl|eth)/i.test(c.name)) ??
    candidates.find((c) => isPrivateV4(c.address)) ??
    candidates[0];
  return preferred?.address ?? null;
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

export function shareUrl(id: string, token: string, port: number, host = lanAddress()): string | null {
  return host ? `http://${host}:${port}/w/${id}?t=${encodeURIComponent(token)}` : null;
}

export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** QR code as an SVG data URL, drawn in the app's ink colour on white. */
export async function qrDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#1E3A2BFF', light: '#FFFFFFFF' },
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
