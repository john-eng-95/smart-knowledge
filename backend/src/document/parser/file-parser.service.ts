import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { RustfsService } from '../../storage/rustfs.service';
import { parseDocx } from './parsers/docx.parser';
import { parsePdf } from './parsers/pdf.parser';
import { parsePlainText } from './parsers/plain-text.parser';
import { parsePptx } from './parsers/pptx.parser';
import { parseXlsx } from './parsers/xlsx.parser';
import { getExtension } from './utils/markdown.util';

/** Supported file extensions. */
const SUPPORTED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'txt',
  'md',
]);

export interface ParseInput {
  originalname: string;
  buffer: Buffer;
  size?: number;
}

/**
 * File-to-Markdown parsing service.
 *
 * Dispatches by extension; injects an image upload callback for PDFs when object storage is available.
 * Throws BadRequestException when parsing returns no content or the format is unsupported.
 */
@Injectable()
export class FileParserService {
  private readonly logger = new Logger(FileParserService.name);

  constructor(private readonly rustfs: RustfsService) {}

  /** Whether the extension is supported (case-insensitive). */
  isSupported(extension: string): boolean {
    return SUPPORTED_EXTENSIONS.has(extension?.toLowerCase());
  }

  /** Comma-separated supported formats for error messages. */
  supportedList(): string {
    return [...SUPPORTED_EXTENSIONS].join(', ');
  }

  /**
   * Parse an uploaded file into a Markdown string.
   *
   * - pdf: optionally extract images and upload them to RustFS (`pdf-images/` prefix).
   * - xlsx: prefer exceljs and fall back to officeparser (see parseXlsxWithFallback).
   * - pptx / docx / txt / md: call the corresponding parser directly.
   */
  async parse(file: ParseInput): Promise<string> {
    const extension = getExtension(file.originalname);

    if (!this.isSupported(extension)) {
      throw new BadRequestException(
        `Unsupported file format: ${extension || '(no extension)'}. Supported formats: ${this.supportedList()}`,
      );
    }

    if (!file.buffer?.length) {
      throw new BadRequestException('The file is empty and cannot be parsed.');
    }

    const start = Date.now();
    let result: string;

    switch (extension) {
      case 'docx':
        result = await parseDocx(file.buffer);
        break;
      case 'pdf':
        result = await parsePdf(file.buffer, {
          // Without storage, omit uploadImage so PDFs produce text/tables only.
          uploadImage: this.rustfs.isEnabled()
            ? (bytes, fileName, contentType) =>
                this.rustfs.uploadBytes(bytes, {
                  fileName,
                  contentType,
                  prefix: 'pdf-images',
                })
            : undefined,
        });
        break;
      case 'pptx':
        result = await parsePptx(file.buffer);
        break;
      case 'xlsx':
        result = await this.parseXlsxWithFallback(file.buffer);
        break;
      case 'txt':
      case 'md':
        result = parsePlainText(file.buffer);
        break;
      default:
        throw new BadRequestException(`Unsupported file format: ${extension}`);
    }

    const elapsed = Date.now() - start;
    this.logger.log(
      `File parsing completed: name=${file.originalname}, format=${extension}, chars=${result.length}, elapsed=${elapsed}ms`,
    );

    if (!result?.trim()) {
      throw new BadRequestException(
        'The parsed result is empty. Confirm that the file contains extractable text.',
      );
    }

    return result;
  }

  /**
   * XLSX: prefer exceljs for structured Markdown tables;
   * fall back to officeparser AST -> Markdown for malformed or damaged files.
   */
  private async parseXlsxWithFallback(buffer: Buffer): Promise<string> {
    try {
      const start = Date.now();
      const result = await parseXlsx(buffer);
      this.logger.log(
        `XLSX (exceljs) parsing succeeded: chars=${result.length}, elapsed=${Date.now() - start}ms`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `XLSX (exceljs) parsing failed; falling back to officeparser: ${message}`,
      );
      const { parseOffice } = await import('officeparser');
      const ast = await parseOffice(buffer, { fileType: 'xlsx' });
      const { value } = await ast.to('md');
      return value ?? '';
    }
  }
}
