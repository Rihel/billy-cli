import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * `ai_connectors.catalog_kind`：记住这条实例对应目录里的哪个型号（`postgres` / `mysql` / `redis`）。
 *
 * 为什么单独一列：`kind` 表达的是"内置 / 自定义"，`driver` 表达"用哪套接法"，
 * 而页面要按**型号**渲染表单字段（同是 `sql` 驱动，PG 与 MySQL 的默认端口就不同）。
 */
export class AiConnectorCatalogKind1794000000001 implements MigrationInterface {
    name = 'AiConnectorCatalogKind1794000000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_connectors" ADD "catalog_kind" character varying(32) NOT NULL DEFAULT ''`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ai_connectors" DROP COLUMN "catalog_kind"`)
    }
}
