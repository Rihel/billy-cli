#!/usr/bin/env bash
# 建连接器同步 topic（本地 docker compose 的 kafka profile）。
# 生产环境由运维按同样参数建：key=connectorId，同一连接器的变更保序。
#
# 注意：AI 流式输出**不走 Kafka**（2026-11-15 起走 Redis pub/sub 定向频道
# `agent:stream:client:<clientId>`），不要再建 `agent.run.events`。
set -euo pipefail
TOPIC="${KAFKA_TOPIC:-app.ai.connector.sync}"
BROKER="${KAFKA_BOOTSTRAP:-localhost:9092}"
CONTAINER="${KAFKA_CONTAINER:-billy-kafka}"

docker exec "$CONTAINER" kafka-topics \
  --bootstrap-server "$BROKER" \
  --create --if-not-exists \
  --topic "$TOPIC" \
  --partitions 1 \
  --replication-factor 1
