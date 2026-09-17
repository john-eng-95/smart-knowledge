/** Normalize Markdown: standardize line endings, collapse blank lines, and trim whitespace. */
export function cleanMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** Escape `|` in table cells and replace newlines with spaces to preserve table structure. */
export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Convert a two-dimensional array to a Markdown table (first row as the header,
 * followed by a `| --- |` separator row).
 * Align columns to the widest row and treat missing cells as empty strings.
 */
export function toMarkdownTable(rows: string[][]): string {
  if (!rows.length) return '';

  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (maxCols === 0) return '';

  const lines: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cells: string[] = [];
    for (let c = 0; c < maxCols; c++) {
      cells.push(escapeTableCell(rows[r][c] ?? ''));
    }
    lines.push(`| ${cells.join(' | ')} |`);
    if (r === 0) {
      lines.push(`| ${Array(maxCols).fill('---').join(' | ')} |`);
    }
  }
  return `${lines.join('\n')}\n\n`;
}

/** Get the lowercase extension without the dot; return an empty string when absent. */
export function getExtension(filename?: string | null): string {
  if (!filename || !filename.includes('.')) return '';
  return filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * Multer/busboy often decodes multipart UTF-8 filename bytes as Latin-1,
 * producing mojibake. Recover the original bytes from Latin-1 and decode as UTF-8.
 */
export function decodeUploadFilename(filename?: string | null): string {
  if (!filename) return '';
  try {
    const decoded = Buffer.from(filename, 'latin1').toString('utf8');
    // Keep the original value when decoding produces replacement characters.
    if (decoded.includes('\uFFFD')) return filename;
    return decoded;
  } catch {
    return filename;
  }
}

/** Remove the extension for a document title; use "Untitled document" for an empty filename. */
export function titleFromFilename(filename?: string | null): string {
  if (!filename) return 'Untitled document';
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}
