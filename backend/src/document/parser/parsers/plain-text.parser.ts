/**
 * Parse TXT / MD files as text.
 *
 * No structural conversion is performed; read UTF-8 as-is for callers to use as Markdown/plain text.
 */
export function parsePlainText(buffer: Buffer): string {
  return buffer.toString('utf8');
}
