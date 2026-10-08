import { registerNumberedSubject } from "../numbering/registry.ts";

/**
 * 发票域的注册接线（#192 切片 1）——app.ts 模块装载时的 import 副作用。
 *
 * invoice 成为编号注册表的**第一个生产注册**（#225 留下的口子：「可编号
 * subject 注册表刻意为空——发票/报价/PO 等单据域进场时注册」），配置面的
 * subjects 下拉从此亮起 invoice 一项。
 *
 * 时区裁决（numbering/service.ts 注释预留的「随第一个真实消费方一起定」）：
 * **维持 UTC**。日期段只服务号串的人读性（INV-202610-1000 的月份标签），不
 * 承载会计期间语义；+8 时区月初 8 小时的标签偏移在「号串可读」这个用途下
 * 无业务后果。将来出现真实按期出账的需求时，经 @ally/config 注入时区，本
 * 注册与分配内核不动（裁决全文见 docs/billing.md 与 docs/numbering.md）。
 */
registerNumberedSubject("invoice", { label: "Invoice" });

/**
 * credit_note（#192 红冲切片）：贷项单与发票同属钱面单据族（CN- 前缀惯例，
 * 号串前缀由配置者在规则里给），没有编号的贷项单不存在（fail closed 同发票）。
 * 时区裁决承袭上面的 invoice 条目：UTC。
 */
registerNumberedSubject("credit_note", { label: "Credit note" });
