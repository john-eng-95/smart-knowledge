import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthUser } from './auth-user.interface';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import {
  ResetPasswordByEmailDto,
  SendResetCodeDto,
} from '../user/dto/extra.dto';
import { UserService } from '../user/user.service';
import { EmailService } from './email.service';
import { EmailActivationService } from './email-activation.service';
import {
  PasswordResetService,
  RESET_CODE_COOLDOWN_SECONDS,
  RESET_CODE_TTL_SECONDS,
} from './password-reset.service';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  userInfo: AuthUser;
}

interface TokenPayload {
  sub: string;
  username: string;
  type: 'access' | 'refresh';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly emailService: EmailService,
    private readonly emailActivation: EmailActivationService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  private accessExpires(): string {
    return this.config.get<string>('JWT_ACCESS_EXPIRES', '2h');
  }

  private refreshExpires(): string {
    return this.config.get<string>('JWT_REFRESH_EXPIRES', '7d');
  }

  private accessExpiresSeconds(): number {
    const raw = this.accessExpires();
    const match = /^(\d+)([smhd])$/.exec(raw);
    if (!match) return 7200;
    const n = Number(match[1]);
    const unit = match[2];
    if (unit === 's') return n;
    if (unit === 'm') return n * 60;
    if (unit === 'h') return n * 3600;
    return n * 86400;
  }

  private requireEmailVerification(): boolean {
    return (
      this.config.get<string>('REQUIRE_EMAIL_VERIFICATION', 'false') === 'true'
    );
  }

  private signAccessToken(user: AuthUser): string {
    const payload: TokenPayload = {
      sub: user.userId,
      username: user.username,
      type: 'access',
    };
    return this.jwtService.sign(payload, {
      expiresIn: this.accessExpires() as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });
  }

  private signRefreshToken(user: AuthUser): string {
    const payload: TokenPayload = {
      sub: user.userId,
      username: user.username,
      type: 'refresh',
    };
    return this.jwtService.sign(payload, {
      expiresIn: this.refreshExpires() as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userService.validateCredentials(
      dto.username,
      dto.password,
    );
    await this.userService.touchLastLogin(user.userId);
    return this.buildLoginResult(user);
  }

  async register(dto: RegisterDto): Promise<{
    userId: string;
    message: string;
    emailVerificationRequired?: boolean;
  }> {
    const result = await this.userService.register({
      ...dto,
      requireEmailVerification: this.requireEmailVerification(),
    });

    if (result.emailVerificationRequired && dto.email) {
      const token = await this.emailActivation.createToken(result.userId);
      try {
        await this.emailService.sendActivationEmail(
          dto.email,
          dto.username,
          token,
        );
      } catch {
        await this.emailActivation.deleteByToken(token);
        throw new BadRequestException(
          'Failed to send the activation email. Please try again later.',
        );
      }
      return {
        userId: result.userId,
        message:
          'Registration successful. Check your email to activate your account.',
        emailVerificationRequired: true,
      };
    }

    return {
      userId: result.userId,
      message: 'Registration successful. Please sign in.',
    };
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    const userId = await this.emailActivation.consumeToken(token);
    if (!userId) {
      throw new BadRequestException(
        'The activation link is invalid or expired.',
      );
    }
    const message = await this.userService.activateEmail(userId);
    return { message };
  }

  async sendResetCode(dto: SendResetCodeDto): Promise<{ message: string }> {
    const user = await this.userService.findByEmail(dto.email);
    if (!user) {
      throw new NotFoundException(
        'No account is registered with this email address.',
      );
    }

    // The initial Redis TTL is about 600 seconds. More than 540 seconds remaining means
    // the previous code was sent less than 60 seconds ago, so block duplicate requests.
    const ttl = await this.passwordReset.getTtl(dto.email);
    if (ttl > RESET_CODE_TTL_SECONDS - RESET_CODE_COOLDOWN_SECONDS) {
      throw new BadRequestException(
        'A verification code was already sent. Please try again later.',
      );
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.passwordReset.set(dto.email, code);
    try {
      await this.emailService.sendResetCodeEmail(
        dto.email,
        user.username,
        code,
      );
    } catch {
      await this.passwordReset.delete(dto.email);
      throw new BadRequestException(
        'Failed to send the email. Please try again later.',
      );
    }
    return { message: 'Verification code sent.' };
  }

  async resetPasswordByEmail(
    dto: ResetPasswordByEmailDto,
  ): Promise<{ message: string }> {
    if (!(await this.passwordReset.verify(dto.email, dto.code))) {
      throw new BadRequestException(
        'The verification code is invalid or expired.',
      );
    }
    await this.userService.resetPasswordByEmail(dto.email, dto.newPassword);
    await this.passwordReset.delete(dto.email);
    return { message: 'Password reset successful. Please sign in.' };
  }

  async refresh(refreshToken: string): Promise<LoginResult> {
    let payload: TokenPayload;
    try {
      payload = this.jwtService.verify<TokenPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException(
        'The refresh token is invalid or expired.',
      );
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token.');
    }
    const user = await this.userService.buildAuthUser(payload.sub);
    return this.buildLoginResult(user);
  }

  async getMe(userId: string): Promise<AuthUser> {
    return this.userService.buildAuthUser(userId);
  }

  async buildAuthUser(userId: string): Promise<AuthUser> {
    return this.userService.buildAuthUser(userId);
  }

  async getReviewerIds(): Promise<string[]> {
    return this.userService.getUserIdsByRoleCode('ROLE_REVIEWER');
  }

  private buildLoginResult(user: AuthUser): LoginResult {
    return {
      accessToken: this.signAccessToken(user),
      refreshToken: this.signRefreshToken(user),
      tokenType: 'Bearer',
      expiresIn: this.accessExpiresSeconds(),
      userInfo: user,
    };
  }
}
