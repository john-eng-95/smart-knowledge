import { IsEmail, IsInt, IsOptional, IsString } from 'class-validator';

/** Administrator update payload for user data. */
export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  realName?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  @IsOptional()
  @IsInt()
  status?: number;
}
