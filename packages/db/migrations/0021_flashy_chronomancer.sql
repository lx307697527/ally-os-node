CREATE TYPE "public"."rule_category" AS ENUM('param', 'switch', 'gate');--> statement-breakpoint
CREATE TYPE "public"."rule_value_type" AS ENUM('number', 'text', 'boolean', 'string_list', 'number_list', 'json');--> statement-breakpoint
ALTER TYPE "public"."config_revision_source" ADD VALUE 'scheduled';--> statement-breakpoint
CREATE TABLE "registry_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"category" "rule_category" NOT NULL,
	"value_type" "rule_value_type" NOT NULL,
	"value" jsonb,
	"changeable_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enable_by" jsonb,
	"adjudication_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_flag" boolean DEFAULT false NOT NULL,
	"risk_note" text,
	"trigger_count" integer DEFAULT 0 NOT NULL,
	"exception_count" integer DEFAULT 0 NOT NULL,
	"override_count" integer DEFAULT 0 NOT NULL,
	"scheduled_value" jsonb,
	"scheduled_effective_at" timestamp with time zone,
	"scheduled_rationale" jsonb,
	"scheduled_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_rules" ADD CONSTRAINT "registry_rules_scheduled_by_id_auth_user_id_fk" FOREIGN KEY ("scheduled_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registry_rules_key_idx" ON "registry_rules" USING btree ("key");
-- ── 首批规则种子(#232 §4.2 全部条目 + §4.6 可插拔模块开关 + §4.8 风险开关)────────
-- 默认值全部来自裁决或业主决定;未定数字(客供料收费、寄存费率、退款阈值、PO
-- 阈值、折扣上限、标签设计费、法规风险清单、提成规则)value = NULL(「待填」上线,
-- #233:待办提醒随任务/报表消费域进场)。硬底线不进注册表(§4.5),本批次刻意
-- 不含任何硬底线键。跳过两行:#232 §4.2 的「标准工时与费率」(R-13-4,每道工序
-- 的运营数据,属生产域不属注册表)与「打样费无默认值销售逐单填」(逐单商务条款;
-- 系统级的含轮数已落 pricing.sample_included_rounds)。
-- 台账补账同 0019 先例:每条种子规则补一行 source='created' 的 v1,使
-- 「行.version = 台账最新版」的不变式从第一行起成立(快照形状与
-- config-versions/families.ts 的 registryRuleSnapshot 逐字段同构)。
INSERT INTO "registry_rules"
  ("key", "label", "category", "value_type", "value", "changeable_by", "enable_by", "adjudication_refs", "risk_flag", "risk_note")
VALUES
  ('pricing.material_markup_pct', 'Material markup (%)', 'param'::rule_category, 'number'::rule_value_type, '20'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-1"]'::jsonb, false, NULL),
  ('pricing.material_tariff_pct', 'Material tariff (%)', 'param'::rule_category, 'number'::rule_value_type, '20'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-1"]'::jsonb, false, NULL),
  ('pricing.material_inbound_freight_usd_per_kg', 'Material inbound freight (USD per kg)', 'param'::rule_category, 'number'::rule_value_type, '3'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-2"]'::jsonb, false, NULL),
  ('pricing.red_sea_material_markup_pct', 'Red Sea material markup (%)', 'param'::rule_category, 'number'::rule_value_type, '10'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-2"]'::jsonb, false, NULL),
  ('pricing.setup_fee_usd', 'Setup and inspection fee (USD, per order, no floor)', 'param'::rule_category, 'number'::rule_value_type, '4000'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-3"]'::jsonb, false, NULL),
  ('pricing.waste_rate_pct', 'Waste rate (%)', 'param'::rule_category, 'number'::rule_value_type, '10'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-4"]'::jsonb, false, NULL),
  ('pricing.fx_buffer_pct', 'FX buffer (%)', 'param'::rule_category, 'number'::rule_value_type, '3'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-5"]'::jsonb, false, NULL),
  ('pricing.supplier_price_valid_days', 'Supplier price validity (days)', 'param'::rule_category, 'number'::rule_value_type, '90'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-6"]'::jsonb, false, NULL),
  ('pricing.quote_valid_days', 'Quote validity (days)', 'param'::rule_category, 'number'::rule_value_type, '14'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-9"]'::jsonb, false, NULL),
  ('pricing.quantity_tiers', 'Quote quantity tiers (units)', 'param'::rule_category, 'number_list'::rule_value_type, '[1000,2000,3000,5000,10000,20000,50000]'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-9"]'::jsonb, false, NULL),
  ('pricing.non_quantity_discount_cap_pct', 'Non-quantity discount cap (%)', 'param'::rule_category, 'number'::rule_value_type, NULL, '["sales_lead"]'::jsonb, NULL, '["R-06-14"]'::jsonb, false, NULL),
  ('pricing.packaging_minimum_usd', 'Packaging minimum order value (USD by packaging type)', 'param'::rule_category, 'json'::rule_value_type, '{"display_box":1000,"sachet":1000,"stick_pack":1000,"bottle":200,"canister":200}'::jsonb, '["admin"]'::jsonb, NULL, '["R-06-15"]'::jsonb, false, NULL),
  ('pricing.customer_supplied_material_fees', 'Customer-supplied material receiving, inspection and storage fees (USD)', 'param'::rule_category, 'json'::rule_value_type, NULL, '["admin"]'::jsonb, NULL, '["R-06-16"]'::jsonb, false, NULL),
  ('pricing.label_design_fee_usd', 'Label design service fee (USD, per order overridable)', 'param'::rule_category, 'number'::rule_value_type, NULL, '["owner"]'::jsonb, NULL, '["OWNER-DECISION-2026-09-30"]'::jsonb, false, NULL),
  ('pricing.sample_included_rounds', 'Sampling fee included rounds', 'param'::rule_category, 'number'::rule_value_type, '1'::jsonb, '["admin"]'::jsonb, NULL, '["R-07-2","R-07-3"]'::jsonb, false, NULL),
  ('flavor_dev.first_round_fee_usd', 'Flavor development round 1 fee (USD)', 'param'::rule_category, 'number'::rule_value_type, '1500'::jsonb, '["admin"]'::jsonb, NULL, '["R-07-4"]'::jsonb, false, NULL),
  ('flavor_dev.included_free_rounds', 'Flavor development free rounds after round 1', 'param'::rule_category, 'number'::rule_value_type, '6'::jsonb, '["admin"]'::jsonb, NULL, '["R-07-4"]'::jsonb, false, NULL),
  ('flavor_dev.pilot_range', 'Pilot batch advisory range (units by form)', 'param'::rule_category, 'json'::rule_value_type, '{"sachet_stick_pack":{"min":2000,"max":5000},"other":{"min":1,"max":1000}}'::jsonb, '["admin"]'::jsonb, NULL, '["R-07-8"]'::jsonb, false, NULL),
  ('pricing.formula_buyout_usd', 'Formula buyout price (USD, per formula)', 'param'::rule_category, 'json'::rule_value_type, '{"before_first_bulk_receipt":5000,"after":20000}'::jsonb, '["owner"]'::jsonb, NULL, '["R-05-11"]'::jsonb, false, NULL),
  ('orders.deposit_min_pct', 'Minimum deposit (%)', 'param'::rule_category, 'number'::rule_value_type, '50'::jsonb, '["owner"]'::jsonb, NULL, '["R-08-2"]'::jsonb, false, NULL),
  ('orders.manual_creation_approval_threshold_usd', 'Manual order creation approval threshold (USD)', 'param'::rule_category, 'number'::rule_value_type, '100000'::jsonb, '["owner"]'::jsonb, NULL, '["R-08-8"]'::jsonb, false, NULL),
  ('contracts.sign_reminder_interval_days', 'Contract sign reminder interval (days)', 'param'::rule_category, 'number'::rule_value_type, '3'::jsonb, '["admin"]'::jsonb, NULL, '["R-08-4"]'::jsonb, false, NULL),
  ('contracts.sign_followup_days', 'Unsigned contract manual follow-up after (days)', 'param'::rule_category, 'number'::rule_value_type, '14'::jsonb, '["admin"]'::jsonb, NULL, '["R-08-4"]'::jsonb, false, NULL),
  ('procurement.po_approval_threshold_usd', 'PO owner-approval threshold (USD)', 'param'::rule_category, 'number'::rule_value_type, NULL, '["owner"]'::jsonb, NULL, '["R-09-2"]'::jsonb, false, NULL),
  ('procurement.po_receipt_variance_alert_pct', 'PO vs receipt variance alert line (%)', 'param'::rule_category, 'number'::rule_value_type, '5'::jsonb, '["admin"]'::jsonb, NULL, '["R-09-5"]'::jsonb, false, NULL),
  ('procurement.supplier_qualification_window_days', 'New supplier qualification completion window (days)', 'param'::rule_category, 'number'::rule_value_type, '30'::jsonb, '["admin"]'::jsonb, NULL, '["R-09-4"]'::jsonb, false, NULL),
  ('inventory.shelf_life_alert_days', 'Shelf-life alert lead time (days)', 'param'::rule_category, 'number'::rule_value_type, '60'::jsonb, '["admin"]'::jsonb, NULL, '["R-10-1"]'::jsonb, false, NULL),
  ('storage.finished_goods_free_days', 'Finished goods free storage (days)', 'param'::rule_category, 'number'::rule_value_type, '30'::jsonb, '["admin"]'::jsonb, NULL, '["R-10-7"]'::jsonb, false, NULL),
  ('storage.finished_goods_monthly_rate_usd', 'Finished goods storage monthly rate (USD per pallet)', 'param'::rule_category, 'number'::rule_value_type, NULL, '["admin"]'::jsonb, NULL, '["R-10-7"]'::jsonb, false, NULL),
  ('settlement.max_settlement_pct', 'Max settlement vs quote (%)', 'param'::rule_category, 'number'::rule_value_type, '110'::jsonb, '["owner"]'::jsonb, NULL, '["R-11-4"]'::jsonb, false, NULL),
  ('settlement.underproduction_block_pct', 'Underproduction invoice block line (%)', 'param'::rule_category, 'number'::rule_value_type, '10'::jsonb, '["owner"]'::jsonb, NULL, '["R-11-4"]'::jsonb, false, NULL),
  ('payments.card_surcharge_pct', 'Credit card surcharge (%)', 'param'::rule_category, 'number'::rule_value_type, '3.9'::jsonb, '["admin"]'::jsonb, NULL, '["R-12-2"]'::jsonb, true, 'Flat 3.9% may exceed card-network rules and some state caps; per-state split deferred. Risk acknowledged by owner, ruling maintained (#232 section 4.8)'),
  ('payments.paypal_surcharge_pct', 'PayPal surcharge (%)', 'param'::rule_category, 'number'::rule_value_type, '3.9'::jsonb, '["admin"]'::jsonb, NULL, '["R-12-3"]'::jsonb, true, 'Flat 3.9% may exceed card-network rules and some state caps; per-state split deferred. Risk acknowledged by owner, ruling maintained (#232 section 4.8)'),
  ('refunds.owner_approval_threshold_usd', 'Refund owner-approval threshold (USD)', 'param'::rule_category, 'number'::rule_value_type, NULL, '["owner"]'::jsonb, NULL, '["R-12-8"]'::jsonb, false, NULL),
  ('crm.first_contact_sla_hours', 'First contact SLA (hours, remind only, no auto-reclaim)', 'param'::rule_category, 'number'::rule_value_type, '24'::jsonb, '["sales_lead"]'::jsonb, NULL, '["R-01-4"]'::jsonb, false, NULL),
  ('booking.lead_time_hours', 'Booking minimum lead time (hours)', 'param'::rule_category, 'number'::rule_value_type, '1'::jsonb, '["sales_lead"]'::jsonb, NULL, '["R-04-9"]'::jsonb, false, NULL),
  ('booking.max_advance_business_days', 'Booking max advance (business days)', 'param'::rule_category, 'number'::rule_value_type, '2'::jsonb, '["sales_lead"]'::jsonb, NULL, '["R-04-10"]'::jsonb, false, NULL),
  ('booking.cancel_cutoff_hours', 'Booking cancellation cutoff (hours before start)', 'param'::rule_category, 'number'::rule_value_type, '4'::jsonb, '["sales_lead"]'::jsonb, NULL, '["R-04-10"]'::jsonb, false, NULL),
  ('booking.customer_no_show_grace_minutes', 'Customer no-show auto-reschedule wait (minutes)', 'param'::rule_category, 'number'::rule_value_type, '15'::jsonb, '["sales_lead"]'::jsonb, NULL, '["R-04-11"]'::jsonb, false, NULL),
  ('booking.sales_absence_alert_minutes', 'Sales absence alert after (minutes)', 'param'::rule_category, 'number'::rule_value_type, '1'::jsonb, '["sales_lead"]'::jsonb, NULL, '["R-04-12"]'::jsonb, false, NULL),
  ('booking.meeting_notes_deadline_hours', 'Meeting notes deadline (hours after meeting)', 'param'::rule_category, 'number'::rule_value_type, '24'::jsonb, '["sales_lead"]'::jsonb, NULL, '["R-04-13"]'::jsonb, false, NULL),
  ('compliance.regulatory_risk_list', 'Regulatory risk list: banned ingredients, NDI, dose caps (blocks quoting on hit)', 'param'::rule_category, 'json'::rule_value_type, NULL, '["owner"]'::jsonb, NULL, '["R-05-5","OWNER-DECISION-2026-09-30"]'::jsonb, false, NULL),
  ('compensation.commission_rules', 'Commission rules (settled-payment basis)', 'param'::rule_category, 'json'::rule_value_type, NULL, '["owner"]'::jsonb, NULL, '["R-13-6"]'::jsonb, false, NULL),
  ('crm.lead_auto_reclaim_enabled', 'Auto-return claimed lead to pool after 48h without customer response', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["sales_lead"]'::jsonb, '["owner"]'::jsonb, '["R-01-6"]'::jsonb, false, NULL),
  ('crm.lead_cooldown_enabled', '7-day cooldown after lead return to pool', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["sales_lead"]'::jsonb, '["owner"]'::jsonb, '["R-01-8"]'::jsonb, false, NULL),
  ('crm.dormant_reclaim_enabled', 'Return customer to pool after 12 months without interaction', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["sales_lead"]'::jsonb, '["owner"]'::jsonb, '["R-01-12"]'::jsonb, false, NULL),
  ('gates.business_exception_enabled', 'Business gate exception: owner one-off bypass with reason (quality gates never bypassable)', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["OWNER-DECISION-2026-09-30"]'::jsonb, false, NULL),
  ('alerts.undercost_quote_enabled', 'Warn sales lead on below-cost quotes', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-06-3","R-06-13"]'::jsonb, true, 'Below-cost quotes are neither blocked nor warned today; enabling only adds a warning. Risk acknowledged by owner, ruling maintained (#232 section 4.8)'),
  ('payments.surcharge_by_state_or_card_enabled', 'Per-state and per-card surcharge rates', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-12-2","R-12-3"]'::jsonb, true, 'Flat 3.9% may exceed card-network rules and some state caps; per-state split deferred. Risk acknowledged by owner, ruling maintained (#232 section 4.8)'),
  ('sales.state_revenue_stats_enabled', 'Per-state revenue statistics', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-13-7"]'::jsonb, true, 'Out-of-state sales may trigger economic nexus; statistics deferred. Risk acknowledged by owner, ruling maintained (#232 section 4.8)'),
  ('complaints.cc_qa_all_enabled', 'CC QA on all complaints regardless of type', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-14-2"]'::jsonb, true, 'Non-quality complaints are not QA-reviewed under type routing. Risk acknowledged by owner, ruling maintained (#232 section 4.8)'),
  ('compensation.claims_cc_qa_enabled', 'CC QA on post-delivery compensation claims', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-14-6"]'::jsonb, true, 'Post-delivery compensation is judged by sales lead without QA under current ruling. Risk acknowledged by owner, ruling maintained (#232 section 4.8)'),
  ('modules.sop_enabled', 'SOP document control module', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-15-6"]'::jsonb, false, NULL),
  ('modules.training_enabled', 'Training records module', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-15-6"]'::jsonb, false, NULL),
  ('modules.calibration_enabled', 'Equipment calibration module', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-15-6"]'::jsonb, false, NULL),
  ('modules.recall_enabled', 'Recall module', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-14-7"]'::jsonb, false, NULL),
  ('modules.retention_sample_enabled', 'Retention sample module', 'switch'::rule_category, 'boolean'::rule_value_type, 'false'::jsonb, '["owner"]'::jsonb, NULL, '["R-14-8"]'::jsonb, false, NULL)
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
WHERE NOT EXISTS (
  SELECT 1 FROM "config_revisions" cr
  WHERE cr."subject_type" = 'registry_rule' AND cr."subject_id" = r."id" AND cr."version" = 1
);

