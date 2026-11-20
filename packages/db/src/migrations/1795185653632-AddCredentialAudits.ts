import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCredentialAudits1795185653632 implements MigrationInterface {
  name = 'AddCredentialAudits1795185653632'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "personal_credential_audits" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "credential_id" character varying(20), "owner_type" character varying(8) NOT NULL, "owner_id" character varying(20) NOT NULL, "action" character varying(16) NOT NULL, "consumer" character varying(32) NOT NULL, "request_id" character varying(64), "detail" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "PK_4c7482f10e19c54ac2bddf203c3" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_credential_audit_owner" ON "personal_credential_audits"  ("owner_type", "owner_id", "created_at") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_credential_audit_credential" ON "personal_credential_audits"  ("credential_id", "created_at") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_credential_audit_credential"`)
    await queryRunner.query(`DROP INDEX "public"."idx_credential_audit_owner"`)
    await queryRunner.query(`DROP TABLE "personal_credential_audits"`)
  }
}
