import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAiMemory1794623491628 implements MigrationInterface {
  name = 'AddAiMemory1794623491628'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_memories" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "user_id" character varying(20) NOT NULL, "agent_key" character varying(64), "kind" character varying(16) NOT NULL DEFAULT 'fact', "mem_key" character varying(64), "content" text NOT NULL, "source" character varying(16) NOT NULL DEFAULT 'manual', "pinned" boolean NOT NULL DEFAULT false, "enabled" boolean NOT NULL DEFAULT true, "use_count" integer NOT NULL DEFAULT '0', "last_used_at" TIMESTAMP(3), "expires_at" TIMESTAMP(3), "metadata" jsonb, CONSTRAINT "PK_5145dcc952f30347ef3dd3ffe50" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_memory_user_agent" ON "ai_memories"  ("user_id", "agent_key") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_memory_user_list" ON "ai_memories"  ("user_id", "enabled", "pinned", "last_used_at") `,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_memory_user_key" ON "ai_memories"  ("user_id", "agent_key", "mem_key") WHERE deleted_at IS NULL AND mem_key IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_memory_user_key"`)
    await queryRunner.query(`DROP INDEX "public"."idx_memory_user_list"`)
    await queryRunner.query(`DROP INDEX "public"."idx_memory_user_agent"`)
    await queryRunner.query(`DROP TABLE "ai_memories"`)
  }
}
