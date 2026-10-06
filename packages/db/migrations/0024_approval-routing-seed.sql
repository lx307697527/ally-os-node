-- ── 审批路线决策表首个种子（#221 决策表进线 × #233 decision_table 值类型）────────
-- R-16-6 的高级角色门从代码常量（ROLE_APPROVAL_CONFIG_KEY）改为注册表里的路由
-- 表：事实 {action} → 审批线 configKey。种子语义与改表前行为逐条等价（grant/revoke
-- 都进 role_grant 线）；「哪条线」从此是配置——按裁决改表即可换线，owner 直通
-- （R-16-5）不受表影响。单元格是 zen 表达式：输入按列 id 对事实做 unary 测试，
-- 输出是表达式（字符串字面量带引号）。表为空 = 不路由任何动作（fail closed）。
--
-- 事务边界（刻意）：drizzle 的 migrate 把全部待跑迁移包进**一个**事务，而 PG 的
-- 55P04 要求 ALTER TYPE ADD VALUE 的新枚举值**提交后**才能使用（enum_in 运行时
-- 检查，::text::enum 也绕不开）。0023 加值、本迁移用值，中间显式 COMMIT 结束
-- drizzle 的事务（0023 的变更与台账行随它原子提交），种子语句在自动提交下跑，
-- 末尾 BEGIN 把事务还给 drizzle 的收尾 COMMIT。代价是本迁移不再整体原子——
-- 所以种子按幂等写（ON CONFLICT DO NOTHING + 台账 NOT EXISTS），失败重跑安全。
COMMIT;--> statement-breakpoint
INSERT INTO "registry_rules"
  ("key", "label", "category", "value_type", "value", "changeable_by", "enable_by", "adjudication_refs", "risk_flag", "risk_note")
VALUES
  ('approval.routing.user_role', 'Approval routing for user_role changes (action to approval line)', 'gate'::rule_category, 'decision_table'::rule_value_type, '{"hitPolicy":"first","inputs":[{"id":"in_action","field":"action","name":"Action"}],"outputs":[{"id":"out_config","field":"configKey","name":"Approval line"}],"rules":[{"_id":"r-grant","in_action":"== ''grant''","out_config":"''role_grant''"},{"_id":"r-revoke","in_action":"== ''revoke''","out_config":"''role_grant''"}]}'::jsonb, '["admin"]'::jsonb, NULL, '["R-16-6"]'::jsonb, false, NULL)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "config_revisions"
  ("subject_type", "subject_id", "version", "snapshot", "changes", "source", "changed_by_id")
SELECT
  'registry_rule',
  r."id",
  1,
  jsonb_build_object(
    'label', r."label",
    'category', r."category"::text,
    'valueType', r."value_type"::text,
    'value', r."value",
    'changeableBy', r."changeable_by",
    'enableBy', r."enable_by",
    'adjudicationRefs', r."adjudication_refs",
    'riskFlag', r."risk_flag",
    'riskNote', r."risk_note"
  ),
  NULL,
  'created',
  NULL
FROM "registry_rules" r
WHERE r."key" = 'approval.routing.user_role'
  AND NOT EXISTS (
    SELECT 1 FROM "config_revisions" cr
    WHERE cr."subject_type" = 'registry_rule' AND cr."subject_id" = r."id" AND cr."version" = 1
  );--> statement-breakpoint
BEGIN;
