output "app_url" {
  value = "${local.https_enabled ? "https" : "http"}://${aws_lb.main.dns_name}"
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecr_server_repository" {
  value = aws_ecr_repository.this["server"].repository_url
}

output "ecr_web_repository" {
  value = aws_ecr_repository.this["web"].repository_url
}

output "github_deploy_role_arn" {
  description = "填到 GitHub 对应 Environment 的变量 AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.github_deploy.arn
}

output "files_bucket" {
  value = aws_s3_bucket.files.id
}
