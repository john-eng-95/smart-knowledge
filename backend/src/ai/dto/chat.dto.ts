import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** RAG chat request. */
export class ChatDto {
  /** Existing session; a new one is created when omitted. */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** User question. */
  @IsString()
  @IsNotEmpty()
  content: string;

  /** Number of chunks to retrieve; defaults to 5. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number = 5;
}
