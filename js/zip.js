// 极简 ZIP 解包：仅支持 store(0) / deflate(8)，用于解析 EPUB / FB2 容器。
// 依赖浏览器内置 DecompressionStream('deflate-raw')，无需任何第三方库，离线可用。
export async function unzip(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);

  // 1) 从文件尾部定位 End Of Central Directory (EOCD)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 ZIP / EPUB 文件");
  const total = dv.getUint16(eocd + 10, true);
  const cdOff = dv.getUint32(eocd + 16, true);

  const out = new Map();
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // 中央目录头签名
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const exLen = dv.getUint16(p + 30, true);
    const cmLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + fnLen));

    // 2) 跳到本地文件头读取数据区
    const lFnLen = dv.getUint16(localOff + 26, true);
    const lExLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lFnLen + lExLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = comp.slice();
    else if (method === 8) data = await inflate(comp);
    else data = comp.slice(); // 其它方式（如 deflate64）暂按原样返回

    out.set(normalizeName(name), data);
    p += 46 + fnLen + exLen + cmLen;
  }
  return out;
}

function normalizeName(n) {
  // 统一为正斜杠、去掉前导 ./
  return n.replace(/\\/g, "/").replace(/^\.\//, "");
}

async function inflate(raw) {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  w.write(raw);
  await w.close();
  const ab = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(ab);
}
