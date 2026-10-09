import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// 只依赖 S3 协议：AWS S3、MinIO、阿里云 OSS、腾讯云 COS 都能用同一份代码，
// 换云只改 endpoint / 凭证。业务代码只使用 Storage 接口，不直接碰 SDK。
export interface Storage {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  signedGetUrl(key: string, expiresInSeconds?: number): Promise<string>;
  signedPutUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;
  /** 删除对象（#110 附件切片）：生命周期清理用，调用方自担「对象已不在」的 404 */
  delete(key: string): Promise<void>;
  /**
   * 对象是否存在与多大（#31 文件内核）：预签名直传的 complete 端点用它把
   * 「客户端声明的字节数」换成「S3 实测的字节数」。对象不存在返回 null；
   * 其他失败（网络、权限）原样抛——「查不到」和「没上传」是两回事，把
   * 基础设施故障吞成 null 会让 complete 把没落桶的文件记成已就位。
   */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  /**
   * 读回对象字节（#128 PDF 服务切片，**可选能力**）：服务端生成的正式单据
   * 存档后由系统自己读回分发（发票 PDF 端点流字节、后续邮件附件），与
   * 「浏览器直传、用户下载走预签名 URL」的附件流是两条路。接口上可选是
   * 刻意的——上传内核的最小面不被读路径绑架，既有实现与 38 处测试假实现
   * 不用跟着长方法；需要读回的调用方经 readStoredBytes 收窄并 fail closed
   * （实现缺能力 = 部署配置错误 → 500，不是 404）。对象不存在返回 null；
   * 其他失败原样抛（与 head 同一裁法）。
   */
  get?(key: string): Promise<Uint8Array | null>;
}

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle?: boolean;
}

export function createS3Storage(opts: S3StorageOptions): Storage {
  const client = new S3Client({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    forcePathStyle: opts.forcePathStyle ?? false,
    // 未显式提供凭证时走默认链（ECS 任务角色 / 环境变量）
    ...(opts.accessKeyId && opts.secretAccessKey
      ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
      : {}),
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: opts.bucket,
          Key: assertSafeKey(key),
          Body: body,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      );
    },
    signedGetUrl(key, expiresInSeconds = 900) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: opts.bucket, Key: assertSafeKey(key) }), {
        expiresIn: expiresInSeconds,
      });
    },
    signedPutUrl(key, contentType, expiresInSeconds = 900) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: opts.bucket, Key: assertSafeKey(key), ContentType: contentType }),
        { expiresIn: expiresInSeconds },
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: assertSafeKey(key) }));
    },
    async head(key) {
      try {
        const out = await client.send(
          new HeadObjectCommand({ Bucket: opts.bucket, Key: assertSafeKey(key) }),
        );
        return { sizeBytes: out.ContentLength ?? 0 };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async get(key) {
      try {
        const out = await client.send(
          new GetObjectCommand({ Bucket: opts.bucket, Key: assertSafeKey(key) }),
        );
        const body = await out.Body?.transformToByteArray();
        return body ?? null;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
  };
}

/**
 * 读回能力的收窄口（#128）：接口上 get 可选，需要读回的调用方统一走这里
 * ——实现没提供就是部署错误，typed error 让路由层映射 500 而不是悄悄降级。
 */
export async function readStoredBytes(storage: Storage, key: string): Promise<Uint8Array | null> {
  if (!storage.get) throw new Error("storage implementation does not support get");
  return await storage.get(key);
}

/** S3 客户端把 404 包成 MetadataKey 含 "NotFound" / name 含 "NotFound" 的错误 */
function isNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name.includes("NotFound")) return true;
  const httpStatus = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return httpStatus === 404;
}

// 防止用户输入拼进对象 key 时出现路径穿越或空段
export function assertSafeKey(key: string): string {
  if (key.length === 0 || key.length > 1024) throw new Error("invalid storage key length");
  if (key.startsWith("/")) throw new Error("storage key must be relative");
  if (key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new Error("storage key contains an invalid path segment");
  }
  return key;
}
