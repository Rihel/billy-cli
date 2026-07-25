import { Injectable } from '@nestjs/common';
import { users } from '@repo/db';
import {
  AppErrorCodes,
  CreateUserDto,
  PageQueryUserDto,
  ResetUserPasswordDto,
  UpdateUserDto,
} from '@repo/shared';
import { ilike, eq, or } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import * as bcrypt from 'bcryptjs';
import { DbService } from '../../infra/db.service.js';
import { AppLoggerService } from '../../infra/logger.service.js';
import { AppError } from '../../errors.js';

type UserRow = typeof users.$inferSelect;
type SafeUser = Omit<
  UserRow,
  'password' | 'resetPasswordToken' | 'resetPasswordTokenExpiry'
>;

@Injectable()
export class UserService {
  constructor(
    private db: DbService,
    private logger: AppLoggerService,
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

  async create(input: z.infer<typeof CreateUserDto>) {
    this.logger.log('create', { email: input.email });
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
    this.logger.log('created', { id: user.id });
    return this.sanitizeUser(user);
  }

  async findMany(input: z.infer<typeof PageQueryUserDto>) {
    this.logger.log('findMany', input);
    const { page, size, keyword, orderBy, order } = input;
    const where = keyword
      ? or(
          ilike(users.email, `%${keyword}%`),
          ilike(users.realName, `%${keyword}%`),
        )
      : undefined;
    return this.db.paginate({
      table: users,
      where,
      orderCol: users[orderBy as keyof typeof users] as PgColumn,
      order,
      page,
      size,
      map: (u) => this.sanitizeUser(u as typeof users.$inferSelect),
    });
  }

  async findById(id: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    if (!user) throw new AppError(AppErrorCodes.UserNotFound);
    return this.sanitizeUser(user);
  }

  async update(input: z.infer<typeof UpdateUserDto>) {
    this.logger.log('update', { userId: input.userId });
    const { userId, ...fields } = input;
    const [user] = await this.db
      .update(users)
      .set(fields)
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new AppError(AppErrorCodes.UserNotFound);
    this.logger.log('updated', { id: user.id });
    return this.sanitizeUser(user);
  }

  async remove(id: string) {
    const [user] = await this.db
      .delete(users)
      .where(eq(users.id, id))
      .returning();
    if (!user) throw new AppError(AppErrorCodes.UserNotFound);
    this.logger.log('removed', { id });
    return { success: true };
  }

  async resetPassword(input: z.infer<typeof ResetUserPasswordDto>) {
    this.logger.log('resetPassword', { userId: input.userId });
    const hashedPassword = await bcrypt.hash(input.password, 10);
    const [user] = await this.db
      .update(users)
      .set({ password: hashedPassword })
      .where(eq(users.id, input.userId))
      .returning();
    if (!user) throw new AppError(AppErrorCodes.UserNotFound);
    return { success: true };
  }
}
