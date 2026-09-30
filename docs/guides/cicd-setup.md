# CI/CD 与 AWS 上线指南

## 为什么用 GitHub Actions，而不是自建 Jenkins

| | GitHub Actions（本项目采用） | 自建 Jenkins |
|---|---|---|
| 运维 | 零运维，GitHub 托管 | 要自己维护服务器、升级、插件兼容、备份 |
| 安全 | OIDC 临时凭证，仓库里**不存任何 AWS 密钥** | 需要在 Jenkins 保存长期凭证，服务器本身也是攻击面 |
| 和代码的关系 | 流水线就是仓库里的 YAML，随 PR 一起评审 | 配置常散落在 Jenkins UI 里，难以追溯 |
| 审批 | Environment 保护规则，一键批准上线 | 需要装插件自己拼 |
| 成本 | 私有仓库每月有免费额度，超出按分钟计费 | 服务器费用 + 人力 |

Jenkins 只在这几种情况才值得：代码不在 GitHub、必须内网构建且不能出网、或已有专职运维团队。
想在自己的机器上构建（省费用或需要访问内网），用 **GitHub 自托管 Runner** 即可，流水线无需改动，见 [self-hosted-runner.md](self-hosted-runner.md)。

## 流水线全貌

```
PR 提交 ─→ CI（ci.yml）
            ├─ lint · typecheck · 单元测试 + Postgres 集成测试 · 依赖漏洞扫描 · 迁移同步检查
            ├─ Docker 镜像构建（server / web）
            └─ Terraform 格式与语法校验
          任何一项失败 → 不能合并

合并到 main ─→ Deploy（deploy.yml）
            ├─ 再跑一遍 CI
            ├─ staging：构建镜像推送 ECR → 数据库迁移（一次性任务）→ 滚动更新 → 冒烟检查   【自动】
            └─ production：同上                                                              【人工批准后】
```

安全网：
- **迁移失败 → 部署中止**，线上继续跑旧版本。
- **新版本健康检查失败 → ECS 熔断器自动回滚**到上一个版本。
- 镜像 tag = 提交 SHA 且不可覆盖，线上每个版本都能追溯到具体提交。

## 首次上线步骤（一次性）

前提：一个 AWS 账号、本机装好 `aws` CLI 与 Terraform ≥ 1.9，并有管理员权限。

### 1. 创建 Terraform 状态桶

```bash
aws s3api create-bucket --bucket ally-terraform-state-<account-id> --region us-east-1
aws s3api put-bucket-versioning --bucket ally-terraform-state-<account-id> \
  --versioning-configuration Status=Enabled
```

### 2. 创建 staging 环境

```bash
cd infra/terraform/aws
cp backend.hcl.example backend-staging.hcl       # 填入状态桶名
cp staging.tfvars.example staging.tfvars
terraform init -backend-config=backend-staging.hcl
terraform apply -var-file=staging.tfvars
```

> 首次 apply 后 ECS 服务会报“拉不到镜像（:bootstrap）”——这是预期的，第一次流水线部署后自动恢复。

记下输出里的 `github_deploy_role_arn` 和 `app_url`。

### 3. 配置 GitHub

仓库 **Settings → Environments**：

- 新建 `staging`，添加 Variables：
  - `AWS_REGION` = `us-east-1`
  - `AWS_DEPLOY_ROLE_ARN` = 上一步的 `github_deploy_role_arn`
  - `ECS_PREFIX` = `ally-staging`
  - `APP_URL` = 上一步的 `app_url`（可选，用于冒烟检查）
- 新建 `production`，同样的变量（值换成 production 的），并勾选 **Required reviewers**，指定可批准上线的人。

仓库 **Settings → Secrets and variables → Actions → Variables**：新增 `DEPLOY_ENABLED` = `true`。

仓库 **Settings → Branches**：给 `main` 加保护规则，要求 PR 且 CI 全部通过。

### 4. 触发第一次部署

合并任意 PR 到 `main`，或在 Actions 页面手动运行 **Deploy**。

### 5. production 环境

```bash
terraform init -reconfigure -backend-config=backend-production.hcl   # key 改为 production.tfstate
terraform apply -var-file=production.tfvars   # create_github_oidc_provider = false
```

正式对外前，在 ACM 申请证书并填入 `certificate_arn`，然后把域名 CNAME 到 ALB。

## 日常操作

| 想做的事 | 怎么做 |
|---|---|
| 上线新功能 | 合并 PR → staging 自动更新 → 验证后在 Actions 页面批准 production |
| 回滚 | Actions 里对上一个正常的提交重新运行 Deploy（镜像已存在，跳过构建，几分钟完成） |
| 改基础设施 | 修改 `infra/terraform/aws` → PR（CI 会校验）→ 合并后本地 `terraform apply` |
| 看日志 | CloudWatch Logs → `/ecs/ally-<env>` |

## 后续可以加强（未做）

- Terraform 也接入流水线（PR 上自动 `plan` 并评论，合并后 `apply`）。
- production 直接复用 staging 验证过的镜像（按 digest 晋升），而不是按同一提交重新构建。
- RDS 连接改为校验证书（当前 `sslmode=no-verify`：链路加密，但不校验服务端证书）。
- 告警：ALB 5xx、ECS 任务反复重启、RDS CPU / 连接数 → SNS / Slack。
