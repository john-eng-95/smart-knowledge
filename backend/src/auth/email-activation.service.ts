import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisService } from '../redis/redis.service';

const TOKEN_PREFIX = 'email:activation:token:';
const USER_PREFIX = 'email:activation:user:';
export const ACTIVATION_TOKEN_TTL_SECONDS = 24 * 3600;

/** Email activation token stored in Redis for 24 hours. */
@Injectable()
export class EmailActivationService {
  constructor(private readonly redis: RedisService) {}

  private tokenKey(token: string): string {
    return `${TOKEN_PREFIX}${token}`;
  }

  private userKey(userId: string): string {
    return `${USER_PREFIX}${userId}`;
  }

  async createToken(userId: string): Promise<string> {
    const existing = await this.redis.get(this.userKey(userId));
    if (existing) {
      await this.redis.del(this.tokenKey(existing));
    }

    const token = randomBytes(32).toString('hex');
    // token -> userId: resolve the account when the user opens the activation link.
    await this.redis.set(
      this.tokenKey(token),
      userId,
      ACTIVATION_TOKEN_TTL_SECONDS,
    );
    // userId -> token: keep one active token per user and revoke the old one on resend.
    await this.redis.set(
      this.userKey(userId),
      token,
      ACTIVATION_TOKEN_TTL_SECONDS,
    );
    return token;
  }

  /** Validate and consume a token, returning the userId. */
  async consumeToken(token: string): Promise<string | null> {
    const userId = await this.redis.get(this.tokenKey(token));
    if (!userId) return null;

    await this.redis.del(this.tokenKey(token));
    await this.redis.del(this.userKey(userId));
    return userId;
  }

  async deleteByToken(token: string): Promise<void> {
    const userId = await this.redis.get(this.tokenKey(token));
    await this.redis.del(this.tokenKey(token));
    if (userId) {
      await this.redis.del(this.userKey(userId));
    }
  }
}
