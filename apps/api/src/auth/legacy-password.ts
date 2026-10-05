import bcrypt from "bcryptjs";
import { verifyPassword } from "better-auth/crypto";

/**
 * 存量密码哈希兼容（#22 切片 5）。
 *
 * 老系统是 Supabase Auth（GoTrue）：`auth.users.encrypted_password` 存 bcrypt
 * （pgcrypto / Rust bcrypt，$2a$ / $2b$，cost 10）。Better Auth 默认是自家
 * scrypt 格式，对 bcrypt 哈希按默认方式 verify 必然 false——不兼容的话导入
 * 即等于强制全员重置密码。
 *
 * 提供自定义 verify 后 better-auth 就不再兜底（create-context.mjs：
 * `options.emailAndPassword?.password?.verify || verifyPassword`，提供即完全
 * 替换），所以 scrypt 分支必须在这里显式回落到 better-auth 的默认校验。
 *
 * 分派按哈希格式：
 * - bcrypt 前缀（$2a$ / $2b$ / $2y$）→ bcrypt 比对。老用户用原密码直接登录
 *   （#22 验收第 1 条），无需重置。
 * - 其余（better-auth scrypt，注册 / 重置写入的新哈希）→ better-auth 默认校验。
 *
 * 新密码仍走 better-auth 默认 hash（scrypt），本切片不改 hash；导入的 bcrypt
 * 在用户下次改密 / 重置时自然换成 scrypt。不做登录成功后重哈希：登录热路径
 * 上多一次写库，复杂度大于收益，而 bcrypt cost 10 本身并未破损。
 *
 * 老系统的 72 字节截断是 bcrypt 语义的一部分（GoTrue 同样截断），bcrypt 比对
 * 天然保持一致行为，不需要额外处理。
 */
const BCRYPT_HASH_PREFIX = /^\$2[aby]\$\d{2}\$/;

export function isBcryptHash(hash: string): boolean {
  return BCRYPT_HASH_PREFIX.test(hash);
}

export async function verifyLegacyPassword(input: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const { hash, password } = input;
  try {
    if (isBcryptHash(hash)) {
      return await bcrypt.compare(password, hash);
    }
    return await verifyPassword({ hash, password });
  } catch {
    // 库层的坏哈希（截断/非法 base64）是抛错不是 false——那是 500；导入的
    // 数据不完美是常态，坏哈希的语义就是「这行密码对不上」：答 401。
    return false;
  }
}
