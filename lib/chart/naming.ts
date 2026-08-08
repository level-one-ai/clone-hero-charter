/**
 * Song folder naming.
 *
 * Kept free of any Node imports so both the server (building the export zip) and the
 * browser (previewing the name live in the properties panel) can use the exact same
 * function. A preview that disagreed with the real filename would be worse than no
 * preview at all.
 */

/**
 * Sanitize a string for use as a filename or folder name.
 * Clone Hero itself is tolerant, but Windows is not: <>:"/\|?* are illegal, and
 * trailing dots or spaces silently break folder creation.
 */
export function sanitizeFilename(input: string, fallback = 'Untitled'): string {
  // Illegal on Windows: < > : " / \ | ? * and any control character. Spaces,
  // hyphens and parentheses are deliberately kept — the export folder is named
  // "Artist - Title (Charter)".
  const ILLEGAL = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const cleaned = Array.from(input)
    .filter((ch) => !ILLEGAL.has(ch) && ch.codePointAt(0)! >= 0x20)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently mangles names ending in a dot or space.
    .replace(/[. ]+$/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

/**
 * Build the Clone Hero song folder name: "ERRA - Gore of Being (enerbewow)".
 *
 * This is the convention the whole Clone Hero custom-song ecosystem uses, and what the
 * in-game song browser and most library managers expect: the charter's name in
 * parentheses identifies whose chart it is when several people have charted the same
 * song. The zip is named after this folder too, so the download extracts straight into
 * Songs/ with the right name already applied.
 */
export function exportFolderName(meta: {
  artist: string;
  name: string;
  charter: string;
}): string {
  const artist = meta.artist.trim() || 'Unknown Artist';
  const title = meta.name.trim() || 'Untitled';
  const charter = meta.charter.trim();
  const base = `${artist} - ${title}`;
  // Omit the parentheses entirely when there is no charter. "Artist - Title ()" reads
  // as a bug and sorts oddly in the song browser.
  return sanitizeFilename(charter ? `${base} (${charter})` : base);
}
