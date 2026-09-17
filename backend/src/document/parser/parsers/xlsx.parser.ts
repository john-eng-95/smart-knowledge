import ExcelJS from 'exceljs';
import { scalarToString } from '../../../common/scalar-string';
import { cleanMarkdown, toMarkdownTable } from '../utils/markdown.util';

/**
 * Parse XLSX as Markdown.
 *
 * Flow:
 * 1. exceljs loads the workbook.
 * 2. Each sheet becomes `## SheetName` plus a Markdown table with the first row as its header.
 * 3. cellToString normalizes cell values to strings (formula results, rich text, and so on).
 * 4. Align columns to the widest row before passing them to toMarkdownTable.
 *
 * Empty sheets retain their heading and blank line so sheet names are not lost.
 * FileParserService falls back to officeparser when exceljs fails.
 */
export async function parseXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const parts: string[] = [];

  workbook.eachSheet((sheet) => {
    parts.push(`## ${sheet.name}\n`);

    const rows: string[][] = [];
    let maxCols = 0;

    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as Array<ExcelJS.CellValue | undefined>;
      const cells: string[] = [];
      // exceljs row.values is 1-based; actualCellCount may be smaller than a sparse row's true last column.
      const last = Math.max(row.actualCellCount, (values?.length ?? 1) - 1);
      maxCols = Math.max(maxCols, last);
      for (let c = 1; c <= last; c++) {
        cells.push(cellToString(row.getCell(c).value));
      }
      rows.push(cells);
    });

    if (maxCols === 0 || rows.length === 0) {
      parts.push('\n');
      return;
    }

    // Rows may have different widths; pad the right side with empty strings.
    const normalized = rows.map((r) => {
      const copy = [...r];
      while (copy.length < maxCols) copy.push('');
      return copy;
    });

    parts.push(toMarkdownTable(normalized));
  });

  return cleanMarkdown(parts.join('\n'));
}

/**
 * Convert an exceljs cell value to a display string.
 *
 * Supports primitive values, Date, formulas (result), hyperlinks (text), rich text, and shared formulas.
 * Unknown objects fall back to String(value).
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return '';

  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    // Formula cells: prefer the calculated result.
    if ('result' in value && value.result != null) {
      return cellToString(value.result);
    }
    // Hyperlinks and similar values: { text, hyperlink }.
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    // Rich text: join each run.
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((t) => t.text).join('');
    }
    // Formula only, with no available result.
    if ('sharedFormula' in value || 'formula' in value) {
      const result = (value as { result?: ExcelJS.CellValue }).result;
      return result != null ? cellToString(result) : '';
    }
  }

  return scalarToString(value);
}
