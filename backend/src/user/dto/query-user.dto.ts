import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Paginated user list query. */
export class QueryUserDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  /** Filter by role code, such as ROLE_REVIEWER. */
  @IsOptional()
  @IsString()
  roleCode?: string;

  /** 0 = disabled, 1 = enabled. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

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
