import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Document list query. */
export class QueryDocumentDto {
  /** Fuzzy title filter. */
  @IsOptional()
  @IsString()
  title?: string;

  /** Category ID. */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** Team ID. */
  @IsOptional()
  @IsString()
  teamId?: string;

  /** Author ID. */
  @IsOptional()
  @IsString()
  authorId?: string;

  /** Status. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  /** Page number, starting at 1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** Items per page. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
