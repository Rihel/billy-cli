import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AiFiles1794394249884 implements MigrationInterface {
    name = 'AiFiles1794394249884'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_files" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "conversation_id" character varying(20) NOT NULL, "source" character varying(8) NOT NULL DEFAULT 'ai', "path" character varying(255) NOT NULL, "filename" character varying(255) NOT NULL, "key" character varying(512) NOT NULL, "media_type" character varying(128) NOT NULL, "bytes" integer NOT NULL DEFAULT '0', "sha256" character varying(64), "user_id" character varying(20), "run_id" character varying(20), "tool_call_id" character varying(64), CONSTRAINT "PK_8d5d36c76fcf95641d61fd024d8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_ai_file_source" ON "ai_files"  ("conversation_id", "source") `);
        await queryRunner.query(`CREATE INDEX "idx_ai_file_conversation" ON "ai_files"  ("conversation_id", "updated_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uk_ai_file_path" ON "ai_files"  ("conversation_id", "path") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uk_ai_file_path"`);
        await queryRunner.query(`DROP INDEX "public"."idx_ai_file_conversation"`);
        await queryRunner.query(`DROP INDEX "public"."idx_ai_file_source"`);
        await queryRunner.query(`DROP TABLE "ai_files"`);
    }

}
