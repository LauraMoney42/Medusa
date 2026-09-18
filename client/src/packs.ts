import * as api from './api';
import { applyTheme } from './theme';

export const PACK_EXTENSION = '.medusa-pack';

/** True for a file the Packs importer should handle rather than attach. */
export function isPackFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(PACK_EXTENSION);
}

/**
 * Read, validate on the server, and apply a dropped or picked pack. The theme
 * is repainted here rather than on the next reload so an import is visible the
 * moment it lands, and the chosen voice is mirrored into the TTS store by the
 * caller if it has one.
 */
export async function importPackFile(file: File): Promise<api.PackManifest> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file.name} is not readable as a Medusa pack.`);
  }
  const result = await api.importPack(parsed);
  try {
    applyTheme(await api.fetchTheme());
  } catch {
    // The pack is installed either way; the theme repaints on the next load.
  }
  return result.manifest;
}

/** Download the current setup as a single `.medusa-pack` file. */
export function downloadPack(pack: api.MedusaPack, fileName: string): void {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith(PACK_EXTENSION) ? fileName : `${fileName}${PACK_EXTENSION}`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Load the saved theme and voice at startup and apply them. */
export async function applySavedLayer(
  setVoicePrefs?: (voice: api.MedusaVoice) => void,
): Promise<void> {
  try {
    applyTheme(await api.fetchTheme());
  } catch {
    // Keep the shipped theme when the layer cannot be read.
  }
  if (!setVoicePrefs) return;
  try {
    setVoicePrefs(await api.fetchVoiceSettings());
  } catch {
    // Keep whatever the TTS store already had.
  }
}
