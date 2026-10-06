import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@ally/db";
import {
  canonicalJson,
  isSubjectSigned,
  signatureHash,
  verifySignerPassword,
} from "./service.ts";

/**
 * 单元测试（不需要数据库）：哈希规范化与口令分派是签名的两个纯函数面。
 * 事务路径（签名落库 + 审计 + 幂等重放）在 routes/esignatures.test.ts 用真库覆盖。
 */

/** 只实现 select().from().where().limit() 这条链的假 db（服务层的最小依赖面） */
function fakeSelectDb(rows: unknown[]): Pick<Db, "select"> {
  const chain = {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  };
  return {
    select: () => chain,
  } as unknown as Pick<Db, "select">;
}

describe("canonicalJson", () => {
  it("is key-order independent at any depth — the hash binds content, not serialization accidents", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ outer: { y: [1, { k: 1, j: 2 }], x: null } })).toBe(
      canonicalJson({ outer: { x: null, y: [1, { j: 2, k: 1 }] } }),
    );
  });

  it("drops undefined values but keeps nulls and array order", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe("signatureHash", () => {
  const base = {
    subjectType: "batch_record",
    subjectId: "00000000-0000-4000-8000-000000000001",
    version: "v3",
    record: { step: "weighing", grams: 250 },
  };

  it("is stable for identical content regardless of key order", () => {
    const reordered = {
      record: { grams: 250, step: "weighing" },
      version: "v3",
      subjectId: base.subjectId,
      subjectType: base.subjectType,
    };
    expect(signatureHash(reordered)).toBe(signatureHash(base));
  });

  it("changes when the signed content or its version changes", () => {
    expect(signatureHash({ ...base, record: { step: "weighing", grams: 251 } })).not.toBe(
      signatureHash(base),
    );
    expect(signatureHash({ ...base, version: "v4" })).not.toBe(signatureHash(base));
    expect(signatureHash({ ...base, subjectId: "00000000-0000-4000-8000-000000000002" })).not.toBe(
      signatureHash(base),
    );
  });
});

describe("verifySignerPassword", () => {
  it("verifies through the same dispatch as login: better-auth scrypt", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(
      await verifySignerPassword(fakeSelectDb([{ password: hash }]), "u1", "correct-horse-battery"),
    ).toBe(true);
    expect(
      await verifySignerPassword(fakeSelectDb([{ password: hash }]), "u1", "wrong"),
    ).toBe(false);
  });

  it("verifies through the same dispatch as login: imported legacy bcrypt (#22 切片 5)", async () => {
    const hash = await bcrypt.hash("old-gotrue-password", 10);
    expect(
      await verifySignerPassword(fakeSelectDb([{ password: hash }]), "u1", "old-gotrue-password"),
    ).toBe(true);
  });

  it("fails closed when the user has no credential account or the hash is null", async () => {
    expect(await verifySignerPassword(fakeSelectDb([]), "u1", "anything")).toBe(false);
    expect(await verifySignerPassword(fakeSelectDb([{ password: null }]), "u1", "anything")).toBe(
      false,
    );
  });
});

describe("isSubjectSigned", () => {
  it("is true exactly when at least one signature row exists on the subject", async () => {
    expect(await isSubjectSigned(fakeSelectDb([]), "task", "t1")).toBe(false);
    expect(await isSubjectSigned(fakeSelectDb([{ id: "sig-1" }]), "task", "t1")).toBe(true);
  });
});
