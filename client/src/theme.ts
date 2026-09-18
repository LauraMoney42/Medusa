import type { MedusaTheme } from './api';

/**
 * Applies a Medusa theme by injecting one `<style>` block that redefines the
 * CSS variables in styles/global.css, and stamping `data-theme` on <html>.
 *
 * Injection rather than per-element styling is what makes the Theme editor
 * preview instant: every component already reads `var(--accent)` and friends,
 * so overriding the variables repaints the whole app in one frame with no
 * re-render. Removing the block restores the shipped Warm Charcoal theme.
 */

const STYLE_ID = 'medusa-theme-override';

/** Blend a hex color toward white or black, for the derived hover tokens. */
function mix(hex: string, toward: 'light' | 'dark', amount: number): string {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const target = toward === 'light' ? 255 : 0;
  const parts = [1, 3, 5].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16);
    const blended = Math.round(channel + (target - channel) * amount);
    return Math.max(0, Math.min(255, blended)).toString(16).padStart(2, '0');
  });
  return `#${parts.join('')}`;
}

/** rgba() from a hex color, for the glow and translucent border tokens. */
function alpha(hex: string, a: number): string {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * The six editable tokens map onto the variable set global.css already uses.
 * Anything derived (hover states, glows, borders) is computed here so a person
 * only ever picks six colors.
 */
export function themeToCss(theme: MedusaTheme): string {
  const light = theme.mode === 'light';
  const edge = light ? 'rgba(0, 0, 0, ' : 'rgba(255, 255, 255, ';
  const gap = theme.density === 'compact' ? '10px' : '14px';

  const lines = [
    `--bg-primary: ${theme.background};`,
    `--bg-secondary: ${theme.surface};`,
    `--bg-tertiary: ${mix(theme.background, light ? 'light' : 'dark', 0.35)};`,
    `--bg-hover: ${edge}0.06);`,
    `--bg-active: ${edge}0.09);`,
    `--text-primary: ${theme.text};`,
    `--text-secondary: ${theme.muted};`,
    `--text-muted: ${mix(theme.muted, light ? 'light' : 'dark', 0.25)};`,
    `--accent: ${theme.accent};`,
    `--accent-hover: ${mix(theme.accent, 'dark', 0.15)};`,
    `--accent-glow: ${alpha(theme.accent, 0.25)};`,
    `--danger: ${theme.danger};`,
    `--border: ${edge}0.08);`,
    `--border-light: ${edge}0.12);`,
    `--border-glow: ${alpha(theme.accent, 0.2)};`,
    `--glass-bg: ${theme.surface};`,
    `--glass-bg-heavy: ${mix(theme.background, light ? 'light' : 'dark', 0.15)};`,
    `--space: ${gap};`,
  ];
  if (theme.font.trim()) lines.push(`--font: ${theme.font.trim()};`);

  return `:root[data-theme="medusa"] {\n  ${lines.join('\n  ')}\n}`;
}

/** Paint a theme immediately. Safe to call on every color-picker change. */
export function applyTheme(theme: MedusaTheme): void {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = themeToCss(theme);
  document.documentElement.dataset.theme = 'medusa';
  document.documentElement.style.colorScheme = theme.mode;
}

/** Drop the override and go back to the theme shipped in global.css. */
export function clearTheme(): void {
  document.getElementById(STYLE_ID)?.remove();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
}
