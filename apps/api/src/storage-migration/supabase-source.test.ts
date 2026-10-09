import { describe, expect, it } from "vitest";
import { createSupabaseStorageSource } from "./supabase-source.ts";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface StubResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBufferLike>;
}

type StubPayload = StubResponse | ((req: RecordedRequest) => StubResponse);

interface FetchRoute {
  match: (method: string, url: string) => boolean;
  payloads: StubPayload[];
}

/** fetch 桩:路由按 (method+url) 匹配,每次命中消耗队列里的下一个应答,
 * 队列见底时重复最后一个——分页与目录递归才能在同一 URL 上走出不同页。 */
function makeFetchStub(routes: FetchRoute[]) {
  const requests: RecordedRequest[] = [];
  const cursors: number[] = routes.map(() => 0);
  const fetchFn = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : input.href;
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(req);
    const index = routes.findIndex((r) => r.match(req.method, url));
    if (index === -1) return Promise.reject(new Error(`unexpected request ${req.method} ${url}`));
    const route = routes[index];
    if (route === undefined) {
      return Promise.reject(new Error(`unreachable: no route at ${String(index)}`));
    }
    const at = Math.min(cursors[index] ?? 0, route.payloads.length - 1);
    cursors[index] = at + 1;
    const item = route.payloads[at];
    const response = typeof item === "function" ? item(req) : item;
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchFn, requests };
}

function okJson(payload: unknown): StubResponse {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

function bytesResponse(bytes: Uint8Array): StubResponse {
  return { ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes.slice().buffer) };
}

const LIST_URL = "https://ref.supabase.co/storage/v1/object/list/bucket";
const BUCKETS_URL = "https://ref.supabase.co/storage/v1/bucket";

function makeSource(routes: Parameters<typeof makeFetchStub>[0], pageSize?: number) {
  const { fetchFn, requests } = makeFetchStub(routes);
  const source = createSupabaseStorageSource({
    baseUrl: "https://ref.supabase.co/",
    serviceRoleKey: "service-role-key",
    fetchFn,
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  return { source, requests };
}

async function collectObjects(
  source: ReturnType<typeof makeSource>["source"],
  bucket: string,
): Promise<{ path: string; sizeBytes: number | null }[]> {
  const objects: { path: string; sizeBytes: number | null }[] = [];
  for await (const obj of source.listObjects(bucket)) objects.push(obj);
  return objects;
}

describe("listBuckets", () => {
  it("returns bucket names from the storage admin API with service auth", async () => {
    const { source, requests } = makeSource([
      {
        match: (m, u) => m === "GET" && u === BUCKETS_URL,
        payloads: [okJson([{ name: "feedback" }, { name: "signing-pdfs" }])],
      },
    ]);
    const buckets = await source.listBuckets();
    expect(buckets).toEqual(["feedback", "signing-pdfs"]);
    expect(requests[0]?.headers.apikey).toBe("service-role-key");
    expect(requests[0]?.headers.authorization).toBe("Bearer service-role-key");
  });

  it("throws with the status on non-200", async () => {
    const { source } = makeSource([
      {
        match: (m, u) => m === "GET" && u === BUCKETS_URL,
        payloads: [{ ok: false, status: 401, json: () => Promise.resolve({ message: "bad" }) }],
      },
    ]);
    await expect(source.listBuckets()).rejects.toThrow("401");
  });
});

describe("listObjects", () => {
  it("walks folders depth-first and normalizes full-path names to bucket-relative", async () => {
    const { source, requests } = makeSource([
      {
        match: (m, u) => m === "POST" && u === LIST_URL,
        payloads: [
          okJson([
            { name: "sub", id: null, metadata: null },
            { name: "top.png", id: "u1", metadata: { size: 3 } },
          ]),
          // 第二页(sub/ 层):全路径形态,归一化后应剥成相对路径
          okJson([{ name: "sub/inner/x.png", id: "u2", metadata: { size: 9 } }]),
        ],
      },
    ]);
    const objects = await collectObjects(source, "bucket");
    // 深度优先:目录条目(sub)在其名字序处立即下钻,top.png 在同页随后
    expect(objects).toEqual([
      { path: "inner/x.png", sizeBytes: 9 },
      { path: "top.png", sizeBytes: 3 },
    ]);
    const bodies = requests.map((r) => JSON.parse(r.body ?? "null") as Record<string, unknown>);
    expect(bodies).toEqual([
      { prefix: "", limit: 100, offset: 0, sortBy: { column: "name", order: "asc" } },
      { prefix: "sub/", limit: 100, offset: 0, sortBy: { column: "name", order: "asc" } },
    ]);
  });

  it("handles relative-name servers: folder names get the prefix appended", async () => {
    const { source, requests } = makeSource([
      {
        match: (m, u) => m === "POST" && u === LIST_URL,
        payloads: [
          okJson([{ name: "sub", id: null, metadata: null }]),
          // 相对形态:名字不带 prefix
          okJson([{ name: "f.png", id: "u3", metadata: { size: 1 } }]),
        ],
      },
    ]);
    const objects = await collectObjects(source, "bucket");
    expect(objects).toEqual([{ path: "f.png", sizeBytes: 1 }]);
    expect(requests).toHaveLength(2);
  });

  it("pages a level with offset until a short page", async () => {
    const fullPage = Array.from({ length: 3 }, (_, i) => ({
      name: `f${String(i)}.png`,
      id: `u${String(i)}`,
      metadata: { size: i },
    }));
    const { source, requests } = makeSource(
      [
        {
          match: (m, u) => m === "POST" && u === LIST_URL,
          payloads: [
            okJson(fullPage),
            okJson([{ name: "last.png", id: "u9", metadata: { size: 9 } }]),
          ],
        },
      ],
      3,
    );
    const objects = await collectObjects(source, "bucket");
    expect(objects.map((o) => o.path)).toEqual(["f0.png", "f1.png", "f2.png", "last.png"]);
    const offsets = requests.map((r) => {
      const body = JSON.parse(r.body ?? "{}") as { offset?: number };
      return body.offset;
    });
    expect(offsets).toEqual([0, 3]);
  });

  it("objects without metadata report null size", async () => {
    const { source } = makeSource([
      {
        match: (m, u) => m === "POST" && u === LIST_URL,
        payloads: [okJson([{ name: "x.png", id: "u1", metadata: null }])],
      },
    ]);
    const objects = await collectObjects(source, "bucket");
    expect(objects).toEqual([{ path: "x.png", sizeBytes: null }]);
  });

  it("rejects malformed list responses (zod, not silent shape drift)", async () => {
    const { source } = makeSource([
      { match: (m, u) => m === "POST" && u === LIST_URL, payloads: [okJson([{ weird: true }])] },
    ]);
    const iterator = source.listObjects("bucket")[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow();
  });
});

describe("download", () => {
  it("fetches object bytes with per-segment encoding", async () => {
    const { source, requests } = makeSource([
      {
        match: (m, u) =>
          m === "GET" && u.startsWith("https://ref.supabase.co/storage/v1/object/bucket/"),
        payloads: [() => bytesResponse(new TextEncoder().encode("pdf-bytes"))],
      },
    ]);
    const bytes = await source.download("bucket", "签名 report/a b.png");
    expect([...bytes]).toEqual([...new TextEncoder().encode("pdf-bytes")]);
    const expectedTail = `${encodeURIComponent("签名 report")}/${encodeURIComponent("a b.png")}`;
    expect(requests[0]?.url).toBe(
      `https://ref.supabase.co/storage/v1/object/bucket/${expectedTail}`,
    );
  });

  it("throws with the status on non-200", async () => {
    const { source } = makeSource([{ match: () => true, payloads: [{ ok: false, status: 404 }] }]);
    await expect(source.download("bucket", "gone.png")).rejects.toThrow("404");
  });
});
