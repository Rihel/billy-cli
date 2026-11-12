import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 文件分享表（设计 `docs/design/file-share.md` §4.1）。
 *
 * 只存 token 的 SHA-256；`expires_at` / `revoked_at` 可空，状态由它们派生，不落状态列。
 */
export class FileShares1794600000000 implements MigrationInterface {
  name = 'FileShares1794600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "file_shares" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "token_hash" character varying(64) NOT NULL, "file_id" character varying(20) NOT NULL, "created_by" character varying(20), "expires_at" TIMESTAMP(3), "revoked_at" TIMESTAMP(3), "views" integer NOT NULL DEFAULT '0', "last_viewed_at" TIMESTAMP(3), CONSTRAINT "PK_file_shares" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_file_share_token" ON "file_shares"  ("token_hash") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_file_share_file" ON "file_shares"  ("file_id", "created_at") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_file_share_expires" ON "file_shares"  ("expires_at") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_file_share_expires"`)
    await queryRunner.query(`DROP INDEX "public"."idx_file_share_file"`)
    await queryRunner.query(`DROP INDEX "public"."uk_file_share_token"`)
    await queryRunner.query(`DROP TABLE "file_shares"`)
  }
}
