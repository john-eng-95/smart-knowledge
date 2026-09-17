import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { DocumentStatus } from '../document-status';

/** Create a document (see DocumentStatus; direct Published is forbidden when review is enabled). */
export class CreateDocumentDto {
  /** Title. */
  @IsString()
  title: string;

  /** Markdown content. */
  @IsString()
  content: string;

  /** Summary. */
  @IsOptional()
  @IsString()
  summary?: string;

  /** Category ID. */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** Team ID. */
  @IsOptional()
  @IsString()
  teamId?: string;

  /** Cover image URL. */
  @IsOptional()
  @IsString()
  coverImage?: string;

  /** Comma-separated tags. */
  @IsOptional()
  @IsString()
  tags?: string;

  /** Status. */
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  /** Notes. */
  @IsOptional()
  @IsString()
  remark?: string;

  /** Whether the document is public. */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
