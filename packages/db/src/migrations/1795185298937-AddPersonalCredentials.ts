import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddPersonalCredentials1795185298937 implements MigrationInterface {
  name = 'AddPersonalCredentials1795185298937'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "personal_credentials" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "owner_type" character varying(8) NOT NULL DEFAULT 'user', "owner_id" character varying(20) NOT NULL, "provider" character varying(32) NOT NULL, "name" character varying(64) NOT NULL, "kind" character varying(16) NOT NULL DEFAULT 'static', "template" character varying(32) NOT NULL, "lifetime" character varying(16) NOT NULL DEFAULT 'long-term', "refresh" character varying(16) NOT NULL DEFAULT 'none', "expires_at" TIMESTAMP(3), "secret_enc" text NOT NULL, "secret_hint" character varying(32), "config" jsonb NOT NULL DEFAULT '{}', "inject" jsonb NOT NULL DEFAULT '[]', "status" character varying(16) NOT NULL DEFAULT 'active', "last_used_at" TIMESTAMP(3), CONSTRAINT "PK_836f7a9f7636ea086477196b7db" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_credential_expiry" ON "personal_credentials"  ("status", "expires_at") WHERE lifetime = 'temporary' AND deleted_at IS NULL`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_credential_owner_provider" ON "personal_credentials"  ("owner_type", "owner_id", "provider") `,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_credential_owner_name" ON "personal_credentials"  ("owner_type", "owner_id", "name") WHERE deleted_at IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_credential_owner_name"`)
    await queryRunner.query(`DROP INDEX "public"."idx_credential_owner_provider"`)
    await queryRunner.query(`DROP INDEX "public"."idx_credential_expiry"`)
    await queryRunner.query(`DROP TABLE "personal_credentials"`)
  }
}
