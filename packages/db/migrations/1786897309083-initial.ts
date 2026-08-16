import { MigrationInterface, QueryRunner } from "typeorm";

export class Initial1786897309083 implements MigrationInterface {
    name = 'Initial1786897309083'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "todos" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "title" text NOT NULL, "description" text, "completed" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_ca8cafd59ca6faaf67995344225" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_update_at_id" ON "todos"  ("updated_at", "id") `);
        await queryRunner.query(`CREATE TABLE "users" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "email" text NOT NULL, "password" text NOT NULL, "real_name" text, "avatar" text, "reset_password_token" text, "reset_password_token_expiry" TIMESTAMP(3), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP INDEX "public"."idx_update_at_id"`);
        await queryRunner.query(`DROP TABLE "todos"`);
    }

}
