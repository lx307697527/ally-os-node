CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at" desc);

-- ── #29：审计日志 append-only ────────────────────────────────────────────────
-- #232 数据底线「审计日志不可删除」（Part 11 审计追踪同义）。审计行被改写或抹掉
-- 时不存在任何合法业务路径——老系统对 core.audit_log 的同一裁决（fix747 立
-- no_update、fix906 补 no_delete：拦截的是「不合法的流量」，不存在合法的行级
-- DELETE，所以无条件拒绝）。drizzle 生成不了触发器，DDL 随本 migration 手写；
-- 本 migration 尚未合并，手写合法。
--
-- 测试清库走 TRUNCATE（DDL，不触发行触发器）——生产代码没有这条路，迁移脚本
-- 与测试夹具之外禁止出现对该表的 TRUNCATE。
CREATE OR REPLACE FUNCTION audit_events_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted (#29)', tg_op
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_is_immutable();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_is_immutable();
