import {
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/** Administrator create-user payload. */
export class CreateUserDto {
  @IsString()
  username: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  realName?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  /** 0 = disabled, 1 = enabled; defaults to 1. */
  @IsOptional()
  @IsInt()
  status?: number;

  /** Role code list; defaults to ROLE_USER. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleCodes?: string[];
}
