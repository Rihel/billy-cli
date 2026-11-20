import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddMarketItems1795188270503 implements MigrationInterface {
  name = 'AddMarketItems1795188270503'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_market_items" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "key" character varying(64) NOT NULL, "name" character varying(64) NOT NULL, "description" text, "category" character varying(32), "type" character varying(8) NOT NULL, "scope" character varying(8) NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}', "icon" character varying(255), CONSTRAINT "PK_850b8b14d8ed5424763407ff226" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_market_type" ON "ai_market_items"  ("type", "scope") `,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_market_key" ON "ai_market_items"  ("key") WHERE deleted_at IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_market_key"`)
    await queryRunner.query(`DROP INDEX "public"."idx_market_type"`)
    await queryRunner.query(`DROP TABLE "ai_market_items"`)
  }
}
