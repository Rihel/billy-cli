import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { users } from '@repo/db';
import {
  AppErrorCodes,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  UpdateInfoDto,
  dayjs,
  nanoid,
} from '@repo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import * as bcrypt from 'bcryptjs';
import { DbService } from '../../infra/db.service.js';
import { AppLoggerService } from '../../infra/logger.service.js';
import { appConfig } from '../../config.js';
import { AppError } from '../../errors.js';

type UserRow = typeof users.$inferSelect;
type SafeUser = Omit<
  UserRow,
  'password' | 'resetPasswordToken' | 'resetPasswordTokenExpiry'
>;

@Injectable()
export class AuthService {
  constructor(
    private db: DbService,
    private logger: AppLoggerService,
    private jwt: JwtService,
  ) {}

  private sanitizeUser(user: UserRow): SafeUser {
    const {
      password: _,
      resetPasswordToken: __,
      resetPasswordTokenExpiry: ___,
      ...safe
    } = user;
    return safe;
  }

  async register(input: z.infer<typeof RegisterDto>) {
    this.logger.log('register', { email: input.email });
    const hashedPassword = await bcrypt.hash(input.password, 10);
    const user = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(users)
        .where(eq(users.email, input.email));
      if (existing) throw new AppError(AppErrorCodes.EmailTaken);
      const [newUser] = await tx
        .insert(users)
        .values({ ...input, password: hashedPassword })
        .returning();
      return newUser;
    });
    this.logger.log('registered', { id: user.id });
    const token = this.jwt.sign({ sub: user.id });
    return { token, user: this.sanitizeUser(user) };
  }

  async login(input: z.infer<typeof LoginDto>) {
    this.logger.log('login', { email: input.email });
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, input.email));

    if (!user) {
      throw new AppError(AppErrorCodes.EmailNotFound);
    }
    const valid = await bcrypt.compare(input.password, user.password);
    if (!valid) throw new AppError(AppErrorCodes.InvalidCredentials);
    const token = this.jwt.sign({ sub: user.id });
    this.logger.log('login success', { id: user.id });
    return { token, user: this.sanitizeUser(user) };
  }

  async forgotPassword(input: z.infer<typeof ForgotPasswordDto>) {
    this.logger.log('forgotPassword', { email: input.email });
    const token = nanoid(32);
    const expiry = dayjs()
      .add(appConfig.resetPasswordTokenTtlMinutes, 'minute')
      .toDate();
    const updated = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, input.email));
      if (!user) return null;
      await tx
        .update(users)
        .set({ resetPasswordToken: token, resetPasswordTokenExpiry: expiry })
        .where(eq(users.id, user.id));
      return user;
    });
    if (!updated) {
      this.logger.warn('forgotPassword: user not found', {
        email: input.email,
      });
      return { success: true };
    }
    this.logger.log('forgotPassword token generated', {
      id: updated.id,
      token,
      expiry,
    });
    return { success: true, token };
  }

  async resetPassword(input: z.infer<typeof ResetPasswordDto>) {
    this.logger.log('resetPassword', { token: input.token });
    const hashedPassword = await bcrypt.hash(input.password, 10);
    await this.db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.resetPasswordToken, input.token));
      if (!user) throw new AppError(AppErrorCodes.InvalidResetToken);
      if (
        !user.resetPasswordTokenExpiry ||
        dayjs().isAfter(user.resetPasswordTokenExpiry)
      ) {
        throw new AppError(AppErrorCodes.ExpiredResetToken);
      }
      await tx
        .update(users)
        .set({
          password: hashedPassword,
          resetPasswordToken: null,
          resetPasswordTokenExpiry: null,
        })
        .where(eq(users.id, user.id));
    });
    this.logger.log('resetPassword success');
    return { success: true };
  }

  async getMe(userId: string) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      throw new AppError(AppErrorCodes.Unauthorized, '用户不存在');
    }
    return this.sanitizeUser(user);
  }

  async updateInfo(userId: string, input: z.infer<typeof UpdateInfoDto>) {
    this.logger.log('updateInfo', { userId });
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      throw new AppError(AppErrorCodes.UserNotFound);
    }
    const updated = await this.db
      .update(users)
      .set({
        realName: input.realName ?? user.realName,
        avatar: input.avatar ?? user.avatar,
      })
      .where(eq(users.id, userId))
      .returning();
    return this.sanitizeUser(updated[0]);
  }

  async changePassword(
    userId: string,
    input: z.infer<typeof ChangePasswordDto>,
  ) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      throw new AppError(AppErrorCodes.UserNotFound);
    }
    const valid = await bcrypt.compare(input.oldPassword, user.password);
    if (!valid) {
      throw new AppError(AppErrorCodes.InvalidOldPassword);
    }
    const samePassword = await bcrypt.compare(input.newPassword, user.password);
    if (samePassword) {
      throw new AppError(AppErrorCodes.PasswordUnchanged);
    }
    const hashedPassword = await bcrypt.hash(input.newPassword, 10);
    await this.db
      .update(users)
      .set({ password: hashedPassword })
      .where(eq(users.id, userId));
    this.logger.log('changePassword success', { userId });
    return { success: true };
  }

  verifyToken(token: string): string {
    try {
      const payload = this.jwt.verify<{ sub: string }>(token);
      return payload.sub;
    } catch {
      throw new AppError(AppErrorCodes.TokenInvalid);
    }
  }
}
