import mammoth from 'mammoth';
import TurndownService from 'turndown';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gfm } = require('turndown-plugin-gfm') as {
  gfm: (service: TurndownService) => void;
};
import { cleanMarkdown } from '../utils/markdown.util';

/**
 * Parse DOCX as Markdown.
 *
 * Flow:
 * 1. mammoth converts DOCX to HTML while preserving headings, lists, tables, and other structure.
 * 2. turndown (+GFM) converts HTML to Markdown.
 * 3. cleanMarkdown normalizes line endings and whitespace.
 *
 * styleMap covers both English and Chinese built-in Word style names so localized Word headings keep their levels.
 */
export async function parseDocx(buffer: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: [
        // English styles.
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Heading 4'] => h4:fresh",
        // Chinese Word built-in "Heading N" styles.
        "p[style-name='标题 1'] => h1:fresh",
        "p[style-name='标题 2'] => h2:fresh",
        "p[style-name='标题 3'] => h3:fresh",
        "p[style-name='标题 4'] => h4:fresh",
      ],
    },
  );

  const turndown = new TurndownService({
    headingStyle: 'atx', // ATX headings (#).
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // GFM extensions such as tables, strikethrough, and task lists.
  turndown.use(gfm);

  return cleanMarkdown(turndown.turndown(html));
}
