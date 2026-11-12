/**
 * 拖放导入 .vpk 的实现（主进程侧，不依赖 Electron，便于单独测试）。
 *
 * 相比最初的版本，这里补了两件事：
 *   1. **封面图**：拖进来的 `xxx.jpg` 会和 `xxx.vpk` 一起落到 addons 目录。
 *      后端 `_find_sidecar_thumbnail` 认的就是「与 vpk 同名的图片」，
 *      以前非 .vpk 的文件一律被丢弃，导入后卡片永远没有封面。
 *   2. **重复检测**：以前只比对文件名，改过名的同一个 Mod 会被重复导入。
 *      现在先按体积筛，体积撞上了再算 SHA-256，内容相同即判定重复并跳过。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

/** 与后端 mod_scanner._SIDECAR_THUMB_EXTS 保持一致 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

/** addons 目录最多向下看两层：`addons/xxx.vpk` 与 `addons/workshop/<id>/xxx.vpk` */
const SCAN_DEPTH = 2;/** 单次导入的文件数上限，避免用户误拖整个磁盘 */
const MAX_IMPORT_FILES = 2000;
/** 索引已有 vpk 的数量上限 */
const MAX_INDEXED_VPKS = 5000;
/** 分块哈希的块大小 */
const HASH_CHUNK = 1024 * 1024;

export interface ImportVpkResult {
  success: boolean;
  count: number;
  skipped: number;
  /** 一并复制进 addons 的封面图数量 */
  covers: number;
  /** 内容相同（改过名的同一个 Mod），已跳过 */
  duplicates: string[];
  /** 同名但内容不同，未覆盖 */
  conflicts: string[];
  /** addons 里原本就存在的重复组（每组给出两个文件名） */
  existingDuplicates: string[][];
  error?: string;
}

function emptyResult(): ImportVpkResult {
  return {
    success: false,
    count: 0,
    skipped: 0,
    covers: 0,
    duplicates: [],
    conflicts: [],
    existingDuplicates: [],
  };
}

/** 递归收集目录里的 vpk 与封面图；depth 限制避免用户误拖整个磁盘 */
function collectImportable(
  dir: string,
  depth: number,
  vpks: string[],
  images: string[]
): void {
  if (depth < 0 || vpks.length + images.length > MAX_IMPORT_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectImportable(full, depth - 1, vpks, images);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.vpk') vpks.push(full);
      else if (IMAGE_EXTS.has(ext)) images.push(full);
    }
  }
}

/**
 * 收集「游戏真正会加载」的 vpk：addons 根目录 + addons/workshop（含 <id> 子目录）。
 *
 * 必须和后端 `mod_scanner.iter_mod_files` 用同一套规则。以前这里递归了 addons 下
 * 所有子目录，于是把用户拖进来的暂存文件夹（例如 `addons/整合包2/`）也算成
 * 「已安装的 Mod」：导入时每个 vpk 都在索引里遇到自己，体积和内容完全一致，
 * 几十个包全被判为重复跳过 —— 真正需要导入的文件一个都没进来。
 */
function collectExistingVpks(addonsPath: string, out: string[]): void {
  const pushVpksIn = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_INDEXED_VPKS) return;
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.vpk')) {
        out.push(path.join(dir, entry.name));
      }
    }
  };

  pushVpksIn(addonsPath);

  // addons/workshop/*.vpk 与 addons/workshop/<id>/*.vpk 都是工坊 Mod 的正式位置
  const workshop = path.join(addonsPath, 'workshop');
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(workshop, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (item.isDirectory()) pushVpksIn(path.join(workshop, item.name));
  }
}

/** 分块计算 SHA-256：几十上百 MB 的 vpk 不整文件读进内存 */
export function hashFileSync(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 把拖入的 vpk / 封面图 / 文件夹复制进 addons 目录。
 *
 * 重复判定规则：
 *   - 同名且内容相同 → `duplicates`；
 *   - 同名但内容不同 → `conflicts`（可能是另一个版本，不覆盖用户已有文件）；
 *   - 文件不同名但内容相同 → `duplicates`（改名后的同一个 Mod）。
 */
export function importDroppedVpks(filePaths: string[], addonsPath: string): ImportVpkResult {
  const result = emptyResult();

  try {
    if (!addonsPath || !fs.existsSync(addonsPath)) {
      return { ...result, error: 'addons 路径无效' };
    }

    // ── 1. 分类（文件夹会递归展开） ──
    const vpkPaths: string[] = [];
    const imagePaths: string[] = [];
    for (const p of filePaths) {
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        collectImportable(p, SCAN_DEPTH, vpkPaths, imagePaths);
      } else if (st.isFile()) {
        const ext = path.extname(p).toLowerCase();
        if (ext === '.vpk') vpkPaths.push(p);
        else if (IMAGE_EXTS.has(ext)) imagePaths.push(p);
      }
    }

    if (vpkPaths.length === 0 && imagePaths.length === 0) {
      return { ...result, success: true };
    }

    // ── 2. 索引现有 vpk，按体积分组 ──
    //     只有体积相同才值得读内容算哈希，导入一个 Mod 不会把整库读一遍。
    const existingVpks: string[] = [];
    collectExistingVpks(addonsPath, existingVpks);

    // 正在导入的源文件不参与「已存在」比对：用户可能把 addons 里的包再拖一次，
    // 或者拖的就是 workshop 目录里的包，拿它和自己比必然判定「重复」。
    const sourcePaths = new Set(vpkPaths.map((p) => path.resolve(p).toLowerCase()));

    const bySize = new Map<number, string[]>();
    for (const p of existingVpks) {
      try {
        const size = fs.statSync(p).size;
        const list = bySize.get(size);
        if (list) list.push(p);
        else bySize.set(size, [p]);
      } catch {
        /* 读不到大小的文件直接跳过 */
      }
    }

    const hashCache = new Map<string, string>();
    const hashOf = (p: string): string => {
      const cached = hashCache.get(p);
      if (cached) return cached;
      const h = hashFileSync(p);
      hashCache.set(p, h);
      return h;
    };

    // ── 3. 复制 vpk ──
    const duplicates: string[] = [];
    const conflicts: string[] = [];
    const coverTargets = new Set<string>(); // 需要找封面的 vpk（含已存在而跳过的）

    for (const src of vpkPaths) {
      const fileName = path.basename(src);
      const destPath = path.join(addonsPath, fileName);
      coverTargets.add(destPath);

      let srcSize: number;
      try {
        srcSize = fs.statSync(src).size;
      } catch {
        result.skipped++;
        continue;
      }

      // 同名：内容相同算重复，否则提示「同名不同内容」
      if (fs.existsSync(destPath)) {
        let same = false;
        try {
          same = fs.statSync(destPath).size === srcSize && hashOf(destPath) === hashOf(src);
        } catch {
          same = false;
        }
        if (same) duplicates.push(fileName);
        else conflicts.push(fileName);
        result.skipped++;
        continue;
      }

      // 改名重复：体积相同才需要读内容
      let dupOf: string | null = null;
      const sameSize = bySize.get(srcSize);
      if (sameSize && sameSize.length > 0) {
        const h = hashOf(src);
        for (const cand of sameSize) {
          if (sourcePaths.has(path.resolve(cand).toLowerCase())) continue;
          try {
            if (hashOf(cand) === h) {
              dupOf = cand;
              break;
            }
          } catch {
            /* 单个文件读失败不影响其余判断 */
          }
        }
      }
      if (dupOf) {
        duplicates.push(fileName);
        result.skipped++;
        continue;
      }

      try {
        fs.copyFileSync(src, destPath);
      } catch (e) {
        console.error(`[Import] Copy failed: ${fileName}`, e);
        result.skipped++;
        continue;
      }
      result.count++;
      // 新文件也纳入索引，同批次内部的重复同样能被拦下
      const list = bySize.get(srcSize);
      if (list) list.push(destPath);
      else bySize.set(srcSize, [destPath]);
    }

    // ── 4. 封面图：与 vpk 同名的图片一并复制进 addons ──
    //     后端认的是「xxx.vpk ↔ xxx.jpg/png/…」，文件名必须对齐。
    const usedImages = new Set<string>();
    const coverNameHint = /(thumb|preview|cover|addon_?image|logo|icon)/i;

    const pickImage = (vpkDest: string): string | null => {
      const stem = path.basename(vpkDest, path.extname(vpkDest)).toLowerCase();
      // 4.1 同名优先
      for (const img of imagePaths) {
        if (usedImages.has(img)) continue;
        if (path.basename(img, path.extname(img)).toLowerCase() === stem) {
          usedImages.add(img);
          return img;
        }
      }
      // 4.2 只拖了一个 Mod 时兜底：名字像封面的那张，或唯一一张图
      if (vpkPaths.length === 1) {
        const rest = imagePaths.filter((img) => !usedImages.has(img));
        const hinted = rest.find((img) => coverNameHint.test(path.basename(img)));
        const chosen = hinted ?? (rest.length === 1 ? rest[0] : null);
        if (chosen) {
          usedImages.add(chosen);
          return chosen;
        }
      }
      return null;
    };

    for (const vpkDest of coverTargets) {
      const img = pickImage(vpkDest);
      if (!img) continue;
      const ext = path.extname(img).toLowerCase();
      const coverDest = path.join(
        addonsPath,
        path.basename(vpkDest, path.extname(vpkDest)) + ext
      );
      if (fs.existsSync(coverDest)) {
        // 封面已经在了（上一轮导入失败时可能只复制了图片）：同样算「找到了封面」
        result.covers++;
        continue;
      }
      try {
        fs.copyFileSync(img, coverDest);
        result.covers++;
      } catch (e) {
        console.error(`[Import] Cover copy failed: ${img}`, e);
      }
    }

    // ── 5. 顺带报告 addons 里本来就有的重复 Mod ──
    for (const list of bySize.values()) {
      if (list.length < 2) continue;
      const seen = new Map<string, string>();
      for (const p of list) {
        let h: string;
        try {
          h = hashOf(p);
        } catch {
          continue;
        }
        const prev = seen.get(h);
        if (prev) {
          const prevName = path.basename(prev);
          if (!result.existingDuplicates.some((g) => g.includes(prevName))) {
            result.existingDuplicates.push([prevName, path.basename(p)]);
          }
        } else {
          seen.set(h, p);
        }
      }
    }

    console.log(
      `[Import] Done: ${result.count} copied, ${result.covers} covers, ${result.skipped} skipped ` +
        `(${duplicates.length} duplicate, ${conflicts.length} name conflict), ` +
        `${result.existingDuplicates.length} existing duplicate group(s)`
    );
    return {
      ...result,
      success: true,
      duplicates,
      conflicts,
    };
  } catch (e: any) {
    console.error('[Import] Error:', e);
    return { ...emptyResult(), error: e?.message || String(e) };
  }
}
