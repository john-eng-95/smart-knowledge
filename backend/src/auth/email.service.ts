import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class EmailService {
  constructor(
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  async sendActivationEmail(
    email: string,
    username: string,
    token: string,
  ): Promise<void> {
    const baseUrl = this.config.get<string>(
      'APP_PUBLIC_URL',
      'http://localhost:3000',
    );
    const link = `${baseUrl}/auth/verify-email?token=${token}`;

    await this.mailer.sendMail({
      to: email,
      subject: 'Activate your Knowledge Hub account',
      text: `Hello ${username}, click the following link to activate your account (valid for 24 hours):\n${link}`,
      html: `
        <p>Hello <strong>${username}</strong>,</p>
        <p>Welcome to Knowledge Hub. Click the link below to activate your account (valid for 24 hours):</p>
        <p><a href="${link}">${link}</a></p>
        <p>If you did not request this, you can ignore this email.</p>
      `,
    });
  }

  async sendResetCodeEmail(
    email: string,
    username: string,
    code: string,
  ): Promise<void> {
    await this.mailer.sendMail({
      to: email,
      subject: 'Your password reset code',
      text: `Hello ${username}, your password reset code is ${code}. It is valid for 10 minutes. Do not share it.`,
      html: `
        <p>Hello <strong>${username}</strong>,</p>
        <p>You requested a password reset. Your verification code is:</p>
        <p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p>
        <p>This code is valid for 10 minutes. Do not share it with anyone.</p>
        <p>If you did not request this, you can ignore this email.</p>
      `,
    });
  }
}
