import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Hybrid RAG search request (does not generate an answer). */
export class RagSearchDto {
  @IsString()
  @IsNotEmpty()
  query: string;

  /** Number of reranked results to return; defaults to 5. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number = 5;
}
