import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { isBcryptHash, verifyLegacyPassword } from "./legacy-password.ts";

// 老系统向量：GoTrue（Rust bcrypt）/ pgcrypto gen_salt('bf', 10) 的 $2a$ 格式，
// 口令为 s3cret-Passw0rd!。固定向量钉住「老库哈希 + 原密码」这个合同，
// 不依赖 bcryptjs 现场生成的哈希（避免实现回归时自我循环地互相印证）。
const LEGACY_BCRYPT_HASH = "$2a$10$b5bN2E9SZp9sOLY6GLkwYOtFijXbv4EKCL4dhbseFP8qmELCINia2";
const LEGACY_PASSWORD = "s3cret-Passw0rd!";

describe("legacy password verify (#22 slice 5)", () => {
  it("verifies a legacy GoTrue bcrypt hash against the original password", async () => {
    expect(isBcryptHash(LEGACY_BCRYPT_HASH)).toBe(true);
    expect(await verifyLegacyPassword({ hash: LEGACY_BCRYPT_HASH, password: LEGACY_PASSWORD })).toBe(true);
  });

  it("rejects a wrong password against a legacy hash", async () => {
    expect(await verifyLegacyPassword({ hash: LEGACY_BCRYPT_HASH, password: "wrong" })).toBe(false);
  });

  it("still verifies better-auth scrypt hashes — the default since slice 1", async () => {
    const hash = await hashPassword("new-style-password");
    expect(isBcryptHash(hash)).toBe(false);
    expect(await verifyLegacyPassword({ hash, password: "new-style-password" })).toBe(true);
    expect(await verifyLegacyPassword({ hash, password: "new-style-passworD" })).toBe(false);
  });

  it("recognizes the $2b$/$2y$ bcrypt spellings too", () => {
    expect(isBcryptHash(LEGACY_BCRYPT_HASH.replace("$2a$", "$2b$"))).toBe(true);
    expect(isBcryptHash(LEGACY_BCRYPT_HASH.replace("$2a$", "$2y$"))).toBe(true);
    expect(isBcryptHash("$2c$10$b5bN2E9SZp9sOLY6GLkwYOtFijXbv4EKCL4dhbseFP8qmELCINia2")).toBe(false);
  });

  it("rejects empty or garbage hashes without throwing", async () => {
    expect(await verifyLegacyPassword({ hash: "", password: LEGACY_PASSWORD })).toBe(false);
    expect(await verifyLegacyPassword({ hash: "not-a-hash", password: LEGACY_PASSWORD })).toBe(false);
    expect(await verifyLegacyPassword({ hash: "$2a$10$", password: LEGACY_PASSWORD })).toBe(false);
  });
});
