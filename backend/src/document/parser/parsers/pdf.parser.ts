import { Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import { cleanMarkdown, toMarkdownTable } from '../utils/markdown.util';
import { scalarToString } from '../../../common/scalar-string';

const logger = new Logger('PdfParser');

/**
 * Image upload callback: upload image bytes extracted during parsing and return an accessible URL.
 * Injected by the caller (for example, an object storage adapter); this module does not depend on storage details.
 */
export type ImageUploader = (
  bytes: Buffer,
  fileName: string,
  contentType: string,
) => Promise<string>;

export interface ParsePdfOptions {
  /**
   * When provided, extract and upload PDF images and write them into the result per page using Markdown image syntax.
   * When omitted, output text only, with optional table appendices.
   */
  uploadImage?: ImageUploader;
  /**
   * Skip images whose width or height is below this pixel threshold (usually decorative icons/noise); defaults to 50.
   * Pass it to pdf-parse as imageThreshold and filter locally as a second check.
   */
  imageThreshold?: number;
}

/**
 * Parse a PDF as Markdown.
 *
 * Flow:
 * 1. Extract text page by page.
 * 2. When uploadImage is provided, extract images per page, upload them, and record their URLs.
 * 3. Assemble each page with text first, followed by that page's `![](url)` images.
 * 4. Try to extract tables; append them under "Detected tables" only when the body has no Markdown table.
 * 5. Destroy the parser in finally to release native resources regardless of success or failure.
 *
 * Image extraction failures do not interrupt parsing and fall back to text only; skip individual images whose uploads fail.
 */
export async function parsePdf(
  buffer: Buffer,
  options: ParsePdfOptions = {},
): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const threshold = options.imageThreshold ?? 50;

  try {
    // ---------- 1. Text: extract page by page ----------
    const textResult = await parser.getText();
    const pageTexts = textResult?.pages ?? [];
    /** pageNumber -> URLs uploaded for that page, preserving extraction order. */
    const pageImageUrls = new Map<number, string[]>();

    // ---------- 2. Optional images: extract -> filter small images -> upload ----------
    if (options.uploadImage) {
      try {
        const imageResult = await parser.getImage({
          imageThreshold: threshold,
          // Keep raw bytes rather than a data URL for direct upload.
          imageBuffer: true,
          imageDataUrl: false,
        });

        for (const page of imageResult?.pages ?? []) {
          const urls: string[] = [];
          let imgIdx = 0;
          for (const image of page.images ?? []) {
            // Filter again in case pdf-parse returned an image with unexpected dimensions.
            if (
              (image.width > 0 && image.width < threshold) ||
              (image.height > 0 && image.height < threshold)
            ) {
              continue;
            }
            if (!image.data?.length) continue;

            // Detect MIME from the file header to choose an extension.
            // Upload WebP with a png extension while preserving the real contentType.
            const contentType = sniffImageContentType(image.data);
            const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
            const fileName = `pdf_img_p${page.pageNumber}_${imgIdx++}.${ext}`;
            try {
              const url = await options.uploadImage(
                Buffer.from(image.data),
                fileName,
                contentType,
              );
              urls.push(url);
            } catch (err) {
              // One failed image should not affect other images or the whole document.
              logger.warn(
                `PDF image upload failed: page=${page.pageNumber}, name=${image.name}, err=${err instanceof Error ? err.message : err}`,
              );
            }
          }
          if (urls.length) {
            pageImageUrls.set(page.pageNumber, urls);
          }
        }

        if (pageImageUrls.size > 0) {
          logger.log(
            `PDF image extraction completed: ${[...pageImageUrls.values()].reduce((n, a) => n + a.length, 0)} images`,
          );
        }
      } catch (err) {
        // If batch image extraction fails, fall back to text-only output.
        logger.warn(
          `PDF image extraction failed; continuing with text only: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // ---------- 3. Assemble Markdown page by page ----------
    // With page text: each page contains text plus its images, separated by blank lines.
    // Without page information: use full text and append all images.
    const parts: string[] = [];
    if (pageTexts.length > 0) {
      for (const page of pageTexts) {
        const text = (page.text ?? '').trim();
        if (text) parts.push(text);

        // page.num and image.pageNumber refer to the same page number.
        const urls = pageImageUrls.get(page.num) ?? [];
        for (const url of urls) {
          parts.push(`![](${url})`);
        }
        // Add an empty item after non-empty pages so join creates paragraph spacing.
        if (text || urls.length) parts.push('');
      }
    } else {
      const fallback = (textResult?.text ?? '').trim();
      if (fallback) parts.push(fallback);
      for (const urls of pageImageUrls.values()) {
        for (const url of urls) parts.push(`![](${url})`);
      }
    }

    let markdown = cleanMarkdown(parts.join('\n\n'));

    // ---------- 4. Best-effort table extraction ----------
    // Append tables only when the body has no Markdown header separator (| ---) to avoid duplicates.
    try {
      const tableResult = await parser.getTable();
      const pages = tableResult?.pages ?? [];
      if (pages.length > 0 && !markdown.includes('| ---')) {
        const tableParts: string[] = [];
        let tableIdx = 0;
        for (const page of pages) {
          for (const table of page.tables ?? []) {
            // pdf-parse returns varying structures; normalize them to string[][] first.
            const rows = normalizePdfTable(table);
            if (rows.length > 0) {
              tableIdx += 1;
              tableParts.push(
                `### Table ${tableIdx}\n\n${toMarkdownTable(rows)}`,
              );
            }
          }
        }
        if (tableParts.length > 0) {
          markdown = cleanMarkdown(
            `${markdown}\n\n## Detected tables\n\n${tableParts.join('\n')}`,
          );
        }
      }
    } catch {
      // Table extraction failure does not affect the primary result.
    }

    return markdown;
  } finally {
    // Release pdf-parse / WASM resources to avoid leaks.
    await parser.destroy();
  }
}

/**
 * Detect image MIME from magic bytes in the file header.
 * Fall back to image/png so the upload side always receives a contentType.
 */
function sniffImageContentType(data: Uint8Array): string {
  // JPEG: FF D8 FF
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 (that is, \x89PNG).
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  // WebP: starts with RIFF (the complete format also contains WEBP; this is a rough check).
  if (
    data.length >= 4 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

/**
 * Normalize the possible structures returned by pdf-parse getTable() into string[][].
 *
 * Supported shapes:
 * - string[][]: already rows and cells.
 * - Nested arrays: recursively normalize and flatten.
 * - { rows } / { data }: unwrap the field and continue recursively.
 * Return an empty array when the shape is not recognized.
 */
function normalizePdfTable(raw: unknown): string[][] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    // An array whose first item is an array represents rows -> cells.
    if (Array.isArray(raw[0])) {
      return (raw as unknown[][]).map((row) =>
        row.map((cell) => scalarToString(cell).trim()),
      );
    }
    // Otherwise, treat it as multiple tables/blocks and concatenate them.
    const merged: string[][] = [];
    for (const item of raw) {
      merged.push(...normalizePdfTable(item));
    }
    return merged;
  }

  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as { rows?: unknown; data?: unknown };
    if (obj.rows) return normalizePdfTable(obj.rows);
    if (obj.data) return normalizePdfTable(obj.data);
  }

  return [];
}
