import type { MigrationInterface, QueryRunner } from "typeorm";

export class AddAdmins1787000000000 implements MigrationInterface {
    name = 'AddAdmins1787000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "admins" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "email" text NOT NULL, "password" text NOT NULL, "real_name" text, "avatar" text, "status" character varying(20) NOT NULL DEFAULT 'enabled', CONSTRAINT "uk_admin_email" UNIQUE ("email", "deleted_at"), CONSTRAINT "pk_admins_id" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "admins"`);
    }

}
