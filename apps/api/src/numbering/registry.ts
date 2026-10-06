/**
 * 可编号 subject 注册表（#225 切片 1：编号规则内核）。
 *
 * 「这个单据类型真的会在属主域里发号」只有属主域自己知道——与可签名注册表
 * （esign/registry.ts）、表单 subject 注册表（custom-fields/registry.ts）、可挂
 * 流程注册表（workflow/registry.ts）同一裁法：内核提供接缝，属主域切片在模块
 * 装载时注册。注册是配置面的前置门（未注册类型不能配编号规则，400）也是分配
 * 语义的一部分：内核本身不校验注册（分配由属主域在自己的事务里调用，能调到就
 * 是已经注册了的），配置面校验——防止出现「能配规则但永远没人用它发号」的死配置。
 *
 * 本切片注册表刻意为空：发票、报价、PO、收据的单据域都在 phase-2+（报价 #229、
 * 采购与定金 #231 等），第一个属主域进场时在此注册。机制先行不留产线——规则
 * 配置、原子分配、格式渲染全部就绪并有集成测试覆盖（测试经 registerNumberedSubject
 * 注入夹具域，与生产同一条路径）。
 */

export interface NumberedSubjectSpec {
  /** 对象的展示名（配置面 subjects 列表用；规则自身的 label 由配置者另填） */
  label: string;
}

const NUMBERED_SUBJECTS: Record<string, NumberedSubjectSpec> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具域 */
export function registerNumberedSubject(subject: string, spec: NumberedSubjectSpec): void {
  NUMBERED_SUBJECTS[subject] = spec;
}

export function numberedSubjectSpec(subject: string): NumberedSubjectSpec | undefined {
  return NUMBERED_SUBJECTS[subject];
}

/** 配置面 subjects 列表（下拉框数据源）：按主题名稳定排序 */
export function numberedSubjects(): { subject: string; label: string }[] {
  return Object.entries(NUMBERED_SUBJECTS)
    .map(([subject, spec]) => ({ subject, label: spec.label }))
    .sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0));
}
