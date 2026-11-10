// Event colours: keep the calendar's exact colour and pick black or white text.

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const DARK = '#000000';
const LIGHT = '#ffffff';

/**
 * Text colour for an event drawn in `bg`: white, except on light colours
 * (yellow, lime, pastels) where it would wash out. The WCAG 2 contrast formula
 * prefers black on mid-tones like blue or red, which reads worse in practice,
 * so this uses a luminance threshold instead.
 */
export function textOn(bg: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return LIGHT;
  return luminance(bg) > 0.4 ? DARK : LIGHT;
}
