import { createHash } from "node:crypto";

/**
 * PDF 字节的确定性（#128 存档语义的地基）。
 *
 * @react-pdf/renderer 的输出里有两处**每次渲染都变**的元数据：
 *  1. Info 对象的 `/CreationDate (D:YYYYMMDDHHMMSSZ)`
 *  2. trailer 的 `/ID [<hex> <hex>]`（文档 ID，随机生成）
 *
 * 页内容、字体引用、对象序号、字节布局本身是完全确定的（同输入同字节，
 * 已由三次渲染逐字节比对钉住）。本模块把两处元数据**锚定替换**成常量，
 * 让「同模型 + 同模板 → 同哈希」成立——存档的 contentSha256、快照测试、
 * 「已存档的不变」验收全部踩在这上面。
 *
 * 锚定，不是全局正则：页面内容流是 Flate 压缩的二进制，全局替换理论上
 * 可能撞上压缩字节序列、把一份好文档悄悄改坏。两处替换各自锚在明文结构
 * 关键字（/CreationDate、trailer）上，正文不可能被碰。
 */

/** latin1 往返对任意字节序列是恒等映射（0-255 ↔ 码位 0-255），安全 */
function toLatin1String(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function fromLatin1String(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "latin1"));
}

const FIXED_DATE = "(D:20000101000000Z)";
const FIXED_ID = "/ID [<00000000000000000000000000000000> <00000000000000000000000000000000>]";

export function stablePdfBytes(bytes: Uint8Array): Uint8Array {
  let s = toLatin1String(bytes);

  // /CreationDate 后紧跟 (D:...)：只动这一个 token
  const dateAnchor = s.indexOf("/CreationDate");
  if (dateAnchor >= 0) {
    const match = /^\(D:\d{14}Z\)/.exec(s.slice(dateAnchor + "/CreationDate".length));
    if (match) {
      const start = dateAnchor + "/CreationDate".length;
      s = s.slice(0, start) + FIXED_DATE + s.slice(start + match[0].length);
    }
  }

  // 独立的日期字符串对象（设了 title/creator 后 pdfkit 会把 CreationDate/
  // ModDate 拆成 <n> 0 obj (D:…) 的裸字符串对象）：锚在「日期串紧跟对象收尾
  // 定界」上替换——压缩正文不可能撞上「20 字节精确结构含两处定位字节」
  s = s.replace(/\(D:\d{14}Z\)\nendobj/g, `${FIXED_DATE}\nendobj`);

  // trailer 里的 /ID：取最后一次出现（trailer 是文件尾部结构）
  const idAnchor = s.lastIndexOf("/ID [");
  if (idAnchor >= 0) {
    const match = /^\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/.exec(s.slice(idAnchor));
    if (match) {
      s = s.slice(0, idAnchor) + FIXED_ID + s.slice(idAnchor + match[0].length);
    }
  }

  return fromLatin1String(s);
}

export function pdfSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(stablePdfBytes(bytes)).digest("hex");
}
