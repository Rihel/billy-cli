import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 技能库：`ai_skills`（元信息 + 启停 + 版本）与 `ai_skill_files`（正文 / 参考文件 / 脚本）。
 *
 * 设计见 `docs/design/ai-skill-library.md` §2.1：DB 是事实源，落盘目录只是给 Mastra 的投影。
 */
export class AiSkillLibrary1794325439344 implements MigrationInterface {
  name = 'AiSkillLibrary1794325439344'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_skills" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "skill_key" character varying(64) NOT NULL, "title" character varying(128) NOT NULL DEFAULT '', "description" text NOT NULL, "frontmatter" jsonb NOT NULL DEFAULT '{}', "enabled" boolean NOT NULL DEFAULT true, "source" character varying(16) NOT NULL DEFAULT 'online', "origin_url" character varying(1024), "version" integer NOT NULL DEFAULT '1', "file_count" integer NOT NULL DEFAULT '1', "content_hash" character varying(64), "last_materialized_at" TIMESTAMP(3), "last_validated_at" TIMESTAMP(3), "warnings" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "PK_ai_skills" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_skill_source" ON "ai_skills" ("source")`)
    await queryRunner.query(`CREATE INDEX "idx_skill_enabled" ON "ai_skills" ("enabled")`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_skill_key" ON "ai_skills" ("skill_key") WHERE deleted_at IS NULL`,
    )
    await queryRunner.query(
      `CREATE TABLE "ai_skill_files" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "skill_id" character varying(20) NOT NULL, "path" character varying(255) NOT NULL, "content" text NOT NULL, "size" integer NOT NULL DEFAULT '0', "sha256" character varying(64) NOT NULL DEFAULT '', CONSTRAINT "PK_ai_skill_files" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_skill_file_skill" ON "ai_skill_files" ("skill_id")`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_skill_file" ON "ai_skill_files" ("skill_id", "path")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_skill_file"`)
    await queryRunner.query(`DROP INDEX "public"."idx_skill_file_skill"`)
    await queryRunner.query(`DROP TABLE "ai_skill_files"`)
    await queryRunner.query(`DROP INDEX "public"."uk_skill_key"`)
    await queryRunner.query(`DROP INDEX "public"."idx_skill_enabled"`)
    await queryRunner.query(`DROP INDEX "public"."idx_skill_source"`)
    await queryRunner.query(`DROP TABLE "ai_skills"`)
  }
}
