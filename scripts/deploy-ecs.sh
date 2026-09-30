#!/usr/bin/env bash
# 部署到 ECS：先跑数据库迁移（一次性任务），成功后再滚动更新 api / worker / web。
# 迁移失败则整个部署中止，线上服务保持旧版本不动。
#
# 需要的环境变量：
#   PREFIX        资源前缀，例如 ally-staging（= ECS 集群名 = 任务定义前缀）
#   SERVER_IMAGE  服务端镜像完整地址（带 tag）
#   WEB_IMAGE     前端镜像完整地址（带 tag）
set -euo pipefail

: "${PREFIX:?}" "${SERVER_IMAGE:?}" "${WEB_IMAGE:?}"
CLUSTER="$PREFIX"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 以当前任务定义为模板，只替换镜像，注册一个新修订版，返回其 ARN
register() {
  local family="$1" image="$2"
  aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json \
    | jq --arg img "$image" '
        .containerDefinitions[0].image = $img
        | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
              .compatibilities, .registeredAt, .registeredBy)' \
    > "$TMP/$family.json"
  aws ecs register-task-definition --cli-input-json "file://$TMP/$family.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

echo "::group::database migration"
migrate_arn="$(register "$PREFIX-migrate" "$SERVER_IMAGE")"
# 迁移任务复用 api 服务的网络配置（私有子网 + 安全组）
network="$(aws ecs describe-services --cluster "$CLUSTER" --services api \
  --query 'services[0].networkConfiguration' --output json)"
task_arn="$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$migrate_arn" --network-configuration "$network" \
  --query 'tasks[0].taskArn' --output text)"
echo "migration task: $task_arn"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"
exit_code="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [[ "$exit_code" != "0" ]]; then
  echo "::error::migration failed (exit code: $exit_code). Services were NOT updated."
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].{stoppedReason:stoppedReason,containers:containers[].reason}'
  exit 1
fi
echo "::endgroup::"

echo "::group::rolling update"
for svc in api worker web; do
  image="$SERVER_IMAGE"
  [[ "$svc" == "web" ]] && image="$WEB_IMAGE"
  arn="$(register "$PREFIX-$svc" "$image")"
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" --task-definition "$arn" \
    --query 'service.serviceName' --output text
done
# 等所有服务稳定；新版本起不来时 ECS 熔断器会自动回滚，这里会超时报错
aws ecs wait services-stable --cluster "$CLUSTER" --services api worker web
echo "::endgroup::"
echo "deployed $SERVER_IMAGE"
