import type * as z from "zod";

/**
 * 表单 subject 注册表（#222 切片 1：自定义字段与表单引擎内核）。
 *
 * #232 §4.9 v2.2：内置字段由属主域用 zod 定义，自定义字段存元数据表
 * （custom_field_defs），两者合成一份 JSON Schema——前端 react-jsonschema-form
 * 渲染和服务端校验共用。但「某个对象类型的内置字段是什么形状」只有属主域自己
 * 知道，与 esign 可签名注册表（esign/registry.ts）同一裁法：内核提供接缝，
 * 属主域切片在模块装载时注册；本切片注册表刻意为空——询价向导（#207/#227 的
 * 对外表单）和清场检查表（phase-3/4 的内部检查表）两个消费域都在后面，机制
 * 先行不留产线，未注册类型由 schema 端点回 400，不出现「能配字段但没地方
 * 渲染」的半开机状态。测试经 registerFormSubject 注入夹具域（与生产同一条路）。
 */

/** 一个表单 subject 的内置字段形状（zod raw shape，合成时与自定义字段并排铺开） */
export interface FormSubjectSpec {
  builtin: z.ZodRawShape;
}

const FORM_SUBJECTS: Record<string, FormSubjectSpec> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具域 */
export function registerFormSubject(subjectType: string, spec: FormSubjectSpec): void {
  FORM_SUBJECTS[subjectType] = spec;
}

export function formSubjectSpec(subjectType: string): FormSubjectSpec | undefined {
  return FORM_SUBJECTS[subjectType];
}
