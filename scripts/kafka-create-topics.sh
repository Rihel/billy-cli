#!/usr/bin/env bash
# 创建 AI 会话运行事件 topic（本地 docker compose 的 kafka profile）。
# 生产环境由运维按同样参数建：3 分区、key=runId，保证同一 run 内有序。
set -euo pipefail
TOPIC="${KAFKA_TOPIC:-app.agent.run.events}"
BROKER="${KAFKA_BOOTSTRAP:-localhost:9092}"
CONTAINER="${KAFKA_CONTAINER:-billy-kafka}"

docker exec "$CONTAINER" kafka-topics \
  --bootstrap-server "$BROKER" \
  --create --if-not-exists \
  --topic "$TOPIC" \
  --partitions 3 \
  --replication-factor 1
