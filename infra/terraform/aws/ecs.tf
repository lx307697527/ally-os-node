resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.env == "production" ? 90 : 14
}

locals {
  # 首次 apply 时 ECR 里还没有镜像，先占位；之后每次部署由 CI 注册新的任务定义修订版替换镜像
  server_image = "${aws_ecr_repository.this["server"].repository_url}:bootstrap"
  web_image    = "${aws_ecr_repository.this["web"].repository_url}:bootstrap"

  server_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "S3_BUCKET", value = aws_s3_bucket.files.id },
    { name = "S3_REGION", value = var.region },
    { name = "CORS_ORIGINS", value = var.cors_origins },
  ]
  server_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "BETTER_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.better_auth_secret.arn },
  ]

  # 名字 → 启动命令。api 对外提供 HTTP，其余不暴露端口
  server_tasks = {
    api     = { command = ["node", "apps/api/src/index.ts"], cpu = var.api_cpu, memory = var.api_memory }
    worker  = { command = ["node", "apps/worker/src/index.ts"], cpu = 256, memory = 512 }
    migrate = { command = ["node", "packages/db/src/migrate.ts"], cpu = 256, memory = 512 }
  }
}

resource "aws_ecs_task_definition" "server" {
  for_each = local.server_tasks

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name         = each.key
    image        = local.server_image
    command      = each.value.command
    essential    = true
    environment  = local.server_environment
    secrets      = local.server_secrets
    portMappings = each.key == "api" ? [{ containerPort = 3000, protocol = "tcp" }] : []
    stopTimeout  = 30
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.task_execution.arn

  container_definitions = jsonencode([{
    name         = "web"
    image        = local.web_image
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "web"
      }
    }
  }])
}

locals {
  services = {
    api    = { task_definition = aws_ecs_task_definition.server["api"].arn, desired = var.api_desired_count, tg = aws_lb_target_group.api.arn, port = 3000 }
    worker = { task_definition = aws_ecs_task_definition.server["worker"].arn, desired = 1, tg = null, port = null }
    web    = { task_definition = aws_ecs_task_definition.web.arn, desired = var.web_desired_count, tg = aws_lb_target_group.web.arn, port = 8080 }
  }
}

resource "aws_ecs_service" "this" {
  for_each = local.services

  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = each.value.task_definition
  desired_count   = each.value.desired
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.tg == null ? [] : [1]
    content {
      target_group_arn = each.value.tg
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  # 新版本起不来（健康检查失败）时自动回滚到上一个版本
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 同一时刻只能有一个 worker 在跑定时任务注册（pg-boss 本身也能处理多实例）
  deployment_minimum_healthy_percent = each.key == "worker" ? 0 : 100
  deployment_maximum_percent         = 200

  # 镜像版本由 CI 部署管理，Terraform 不回滚它
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.http]
}
