import { z } from "zod";
import type { SourceObject, StorageMigrationSource } from "./migrate.ts";

/**
 * Supabase Storage REST 源(#31 迁移):service role key 鉴权,
 * `GET /storage/v1/bucket` 枚举桶,`POST /storage/v1/object/list/{bucket}`
 * 分页枚举、目录条目(id=null)递归下钻,`GET /storage/v1/object/{bucket}/…`
 * 下载字节。只在切换窗口的脚本里用,不在服务运行面。
 */

export interface SupabaseStorageSourceOptions {
  /** 例:https://<project>.supabase.co(不带尾部斜杠) */
  baseUrl: string;
  serviceRoleKey: string;
  /** 注入测试用,缺省全局 fetch */
  fetchFn?: typeof fetch | undefined;
  /** 每页条数,缺省 100 */
  pageSize?: number | undefined;
}

/** 桶清单:只取名字,其余字段随它去 */
const bucketListSchema = z.array(z.looseObject({ name: z.string().min(1) }));

/**
 * 目录条目:目录 id=null 且无 metadata;对象 id 为 uuid。`name` 的相对/全路径
 * 形态随服务版本有差(老版回全路径,新版回前缀相对),核心统一归一化,
 * 这里照单全收。
 */
const objectListSchema = z.array(
  z.looseObject({
    name: z.string().min(1),
    id: z.string().nullable(),
    metadata: z.object({ size: z.number() }).nullish(),
  }),
);

export function createSupabaseStorageSource(
  opts: SupabaseStorageSourceOptions,
): StorageMigrationSource {
  const fetchFn = opts.fetchFn ?? fetch;
  const pageSize = opts.pageSize ?? 100;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = {
    apikey: opts.serviceRoleKey,
    authorization: `Bearer ${opts.serviceRoleKey}`,
  };

  async function requestJson(url: string, init: RequestInit): Promise<unknown> {
    const res = await fetchFn(url, init);
    if (!res.ok) {
      throw new Error(`supabase storage ${init.method ?? "GET"} ${url} -> ${res.status}`);
    }
    return res.json();
  }

  async function listPage(
    bucket: string,
    prefix: string,
    offset: number,
  ): Promise<z.infer<typeof objectListSchema>> {
    const body = {
      prefix,
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" as const },
    };
    const parsed = objectListSchema.parse(
      await requestJson(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return parsed;
  }

  /** 目录条目的名字统一成相对路径(全路径形态剥掉前缀,相对形态原样) */
  function relativeTo(prefix: string, name: string): string {
    return prefix !== "" && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  }

  async function* walk(bucket: string, prefix: string): AsyncIterable<SourceObject> {
    let offset = 0;
    for (;;) {
      const entries = await listPage(bucket, prefix, offset);
      for (const entry of entries) {
        if (entry.id === null) {
          // 目录:下钻一层。相对名拼前缀,别对「目录名」再追加斜杠两次
          const rel = relativeTo(prefix, entry.name).replace(/\/+$/, "");
          if (rel.length === 0) continue;
          yield* walk(bucket, `${prefix}${rel}/`);
        } else {
          yield { path: relativeTo(prefix, entry.name), sizeBytes: entry.metadata?.size ?? null };
        }
      }
      if (entries.length < pageSize) return;
      offset += pageSize;
    }
  }

  return {
    async listBuckets() {
      const parsed = bucketListSchema.parse(
        await requestJson(`${base}/storage/v1/bucket`, { headers }),
      );
      return parsed.map((b) => b.name);
    },

    listObjects(bucket) {
      return walk(bucket, "");
    },

    async download(bucket, path) {
      // 逐段编码:路径里的空格、中文、& 都安全,斜杠保持结构
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetchFn(`${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`, {
        headers,
      });
      if (!res.ok) {
        throw new Error(`supabase storage GET object ${bucket}/${path} -> ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
