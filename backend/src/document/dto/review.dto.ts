import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Review task list query (review workspace). */
export class QueryReviewTasksDto {
  /** Filter: pending, approved, or rejected; defaults to pending. */
  @IsOptional()
  @IsString()
  status?: 'pending' | 'approved' | 'rejected';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/** Approve/reject request body (reviewer identity comes from JWT, not the body). */
export class ReviewDecisionDto {
  /** Review comment (required when rejecting). */
  @IsOptional()
  @IsString()
  reviewComment?: string;
}
