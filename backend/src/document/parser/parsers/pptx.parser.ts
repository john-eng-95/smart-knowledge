import JSZip from 'jszip';
import { parseOffice } from 'officeparser';
import { cleanMarkdown, toMarkdownTable } from '../utils/markdown.util';

/**
 * Parse PPTX as Markdown.
 *
 * Prefer the ZIP/XML path (`## Slide N` plus title, body, and tables for each slide).
 * Fall back to officeparser AST -> Markdown when extraction fails.
 */
export async function parsePptx(buffer: Buffer): Promise<string> {
  try {
    return await parsePptxWithZip(buffer);
  } catch {
    return parsePptxWithOfficeParser(buffer);
  }
}

/** Fallback path: convert through officeparser. */
async function parsePptxWithOfficeParser(buffer: Buffer): Promise<string> {
  const ast = await parseOffice(buffer, { fileType: 'pptx' });
  const { value } = await ast.to('md');
  return cleanMarkdown(value ?? '');
}

/**
 * ZIP/XML path: unpack PPTX (OOXML) and extract slides in slideN.xml order.
 *
 * Slide structure:
 * 1. `## Slide N`
 * 2. Tables (Markdown tables).
 * 3. title / ctrTitle placeholders -> `### Title`.
 * 4. Remaining body paragraphs, excluding text already included in titles.
 *
 * Remove `<a:tbl>` from XML after extracting tables so cell text is not repeated in the body.
 */
async function parsePptxWithZip(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slidePaths.length === 0) {
    throw new Error('No PPTX slides found');
  }

  const parts: string[] = [];

  for (let i = 0; i < slidePaths.length; i++) {
    const xml = await zip.file(slidePaths[i])!.async('string');
    parts.push(`## Slide ${i + 1}\n`);

    const tables = extractTables(xml);
    for (const table of tables) {
      parts.push(toMarkdownTable(table));
    }

    // Remove table regions so cell text is not repeated in the body.
    const bodyXml = xml.replace(/<a:tbl[\s\S]*?<\/a:tbl>/g, '');

    const titleTexts = extractPlaceholderTexts(bodyXml, /ctrTitle|title/i);
    const bodyParagraphs = extractParagraphTexts(bodyXml);

    const used = new Set(titleTexts.map((t) => t.trim()).filter(Boolean));
    for (const t of titleTexts) {
      const text = t.trim();
      if (text) parts.push(`### ${text}\n`);
    }

    const bodyLines: string[] = [];
    for (const t of bodyParagraphs) {
      const text = t.trim();
      if (!text || used.has(text)) continue;
      bodyLines.push(text);
    }
    if (bodyLines.length > 0) {
      parts.push(`${bodyLines.join('\n')}\n\n`);
    }
  }

  const result = cleanMarkdown(parts.join('\n'));
  if (!result) {
    throw new Error('PPTX extraction returned no content');
  }
  return result;
}

/** Parse a slide number from `ppt/slides/slide12.xml` for sorting. */
function slideNumber(path: string): number {
  const m = path.match(/slide(\d+)\.xml$/i);
  return m ? Number(m[1]) : 0;
}

/**
 * Extract paragraph text: merge multiple `<a:t>` runs within an `<a:p>`,
 * and convert `<a:br/>` to line breaks.
 */
function extractParagraphTexts(xml: string): string[] {
  const paragraphs: string[] = [];
  const pBlocks = xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) ?? [];
  for (const p of pBlocks) {
    const text = extractRunsText(p);
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs;
}

/**
 * Extract text from shapes with the requested placeholder type, merging paragraphs.
 * typePattern usually matches title / ctrTitle.
 */
function extractPlaceholderTexts(xml: string, typePattern: RegExp): string[] {
  const texts: string[] = [];
  // Split by shape and inspect `<p:ph type="...">`.
  const shapes = xml.split(/<p:sp[\s>]/).slice(1);
  for (const shape of shapes) {
    const ph = shape.match(/<p:ph[^>]*\btype="([^"]+)"/i);
    if (!ph || !typePattern.test(ph[1])) continue;
    const paras = extractParagraphTexts(shape);
    const joined = paras.join('\n').trim();
    if (joined) texts.push(joined);
  }
  return texts;
}

/** Extract all `<a:tbl>` elements from slide XML as string[][][] (tables -> rows -> cells). */
function extractTables(xml: string): string[][][] {
  const tables: string[][][] = [];
  const tableBlocks = xml.match(/<a:tbl[\s\S]*?<\/a:tbl>/g) ?? [];

  for (const block of tableBlocks) {
    const rows: string[][] = [];
    const trBlocks = block.match(/<a:tr[\s\S]*?<\/a:tr>/g) ?? [];
    for (const tr of trBlocks) {
      const cells: string[] = [];
      const tcBlocks = tr.match(/<a:tc[\s\S]*?<\/a:tc>/g) ?? [];
      for (const tc of tcBlocks) {
        // Join multiple paragraphs in a cell with spaces.
        const cellParas = extractParagraphTexts(tc);
        cells.push(cellParas.join(' ').trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }

  return tables;
}

/** Collect text runs in a block and convert explicit `<a:br/>` breaks to `\n`. */
function extractRunsText(xml: string): string {
  let result = '';
  const re = /<a:br\s*\/>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[0].startsWith('<a:br')) {
      result += '\n';
    } else {
      result += decodeXml(m[1]);
    }
  }
  return result;
}

/** Unescape OOXML text entities. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
