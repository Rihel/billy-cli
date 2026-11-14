import type { MigrationInterface, QueryRunner } from 'typeorm'

export class ModelGatewayUsageTotalTokens1794676931674 implements MigrationInterface {
  name = 'ModelGatewayUsageTotalTokens1794676931674'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "model_gateway_usage" ADD "total_tokens" bigint`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "model_gateway_usage" DROP COLUMN "total_tokens"`)
  }
}
