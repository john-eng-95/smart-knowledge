import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** Sign-in request. */
export class LoginDto {
  @IsString()
  username: string;

  @IsString()
  password: string;
}

/** Registration request (sign-in is immediate by default; email activation is required when REQUIRE_EMAIL_VERIFICATION=true). */
export class RegisterDto {
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
}

/** Refresh token request. */
export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}
