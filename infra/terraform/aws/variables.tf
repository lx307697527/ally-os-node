variable "env" {
  description = "环境名：staging / production。每个环境一份独立状态和一套独立资源。"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "github_repository" {
  description = "允许通过 OIDC 部署的 GitHub 仓库，格式 owner/repo"
  type        = string
  default     = "lx307697527/ally-os-node"
}

variable "create_github_oidc_provider" {
  description = "每个 AWS 账号只能有一个 GitHub OIDC provider：第一个环境设 true，其余设 false"
  type        = bool
  default     = true
}

variable "certificate_arn" {
  description = "ACM 证书 ARN。留空则只开 HTTP（仅适合刚起步验证），正式环境必须配置"
  type        = string
  default     = ""
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "web_desired_count" {
  type    = number
  default = 1
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

# ---------- 邮件（#22 邮件基建切片）----------
variable "resend_api_key" {
  description = "Resend API key（Resend 控制台申请，生产必须配置，否则验证邮件只进日志发不出去）"
  type        = string
  default     = ""
  sensitive   = true
}

variable "email_from" {
  description = "发件人，形如 `Ally OS <noreply@example.com>`；Resend 只认已验证域名"
  type        = string
  default     = "Ally OS <noreply@allyos.example>"
}

variable "web_app_url" {
  description = "后台控制台对外地址（验证邮件链接落到它身上）；公有域名定下来后配置"
  type        = string
  default     = ""
}

variable "cors_origins" {
  description = "逗号分隔的前端域名"
  type        = string
  default     = ""
}
