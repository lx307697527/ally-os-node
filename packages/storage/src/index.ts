import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// 只依赖 S3 协议：AWS S3、MinIO、阿里云 OSS、腾讯云 COS 都能用同一份代码，
// 换云只改 endpoint / 凭证。业务代码只使用 Storage 接口，不直接碰 SDK。
export interface Storage {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  signedGetUrl(key: string, expiresInSeconds?: number): Promise<string>;
  signedPutUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;
  /** 删除对象（#110 附件切片）：生命周期清理用，调用方自担「对象已不在」的 404 */
  delete(key: string): Promise<void>;
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
  };
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
