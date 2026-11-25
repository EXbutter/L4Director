/**
 * 整合包 ZIP 导入（主进程侧，不依赖 Electron，便于单独测试）。
 *
 * 与「导出整合包」形成闭环：导出时 ZIP 根目录带一份 `_name_map.json`
 * （`{"mod_1.vpk":"原名.vpk","mod_1_thumb.jpg":"原名.jpg"}`），这里按它把
 * 条目还原成**原文件名**，再复用 `vpkImport.importDroppedVpks` 的落盘/判重逻辑
 * ——不另写一套 VPK 写入，保证「同内容同名跳过、同名不同内容不覆盖」与拖放导入一致。
 *
 * 安全：拒绝 `..` / 绝对路径 / 盘符 / 符号链接条目；限制条目数与解压总大小；
 * 临时目录在 finally 里清理；所有写盘都由 importDroppedVpks 落在 addons 内。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import extract from 'extract-zip';
import { importDroppedVpks, type ImportVpkResult } from './vpkImport';

/** 与 vpkImport 一致：这些扩展名当作封面图一并落盘 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);

/** 单次导入的 ZIP 条目上限 */
const MAX_ENTRIES = 5000;
/** 解压后总体积上限：4 GiB（整合包含地图时可能很大，但不能无上限） */
const MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024;

export interface PackImportZipResult {
  ok: boolean;
  /** 复用拖放导入得到的结果（复制数 / 重复 / 同名冲突等） */
  importResult?: ImportVpkResult;
  /** 建包用的成员名：导入后确实存在于 addons 根目录的 vpk 原名 */
  members: string[];
  error?: string;
}

/** ZIP 条目名是否安全（防 zip-slip / 绝对路径 / 盘符 / 父目录穿越） */
function isSafeEntryName(name: string): boolean {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(n)) return false; // Windows 盘符（C:...）
  return !n.split('/').some((part) => part === '..');
}

/** 条目是否是符号链接（zip 的 unix 模式位） */
function isSymlinkEntry(entry: any): boolean {
  const mode = (Number(entry?.externalFileAttributes) >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

/**
 * 导入一个整合包 ZIP：解压 → 按 _name_map 还原原名 → 复用拖放导入 → 收集成员。
 */
export async function importPackZip(zipPath: string, addonsPath: string): Promise<PackImportZipResult> {
  const fail = (error: string): PackImportZipResult => ({ ok: false, members: [], error });

  if (!zipPath || !fs.existsSync(zipPath)) {
    return fail('整合包 ZIP 文件不存在');
  }
  if (!addonsPath || !fs.existsSync(addonsPath)) {
    return fail('addons 目录无效，请先在设置里指定');
  }

  let tmpRoot = '';
  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l4d2-pack-'));
    const extractedDir = path.join(tmpRoot, 'extracted');
    fs.mkdirSync(extractedDir, { recursive: true });

    // ── 1. 解压到临时目录（带安全校验） ──
    let entryCount = 0;
    let totalUncompressed = 0;
    await extract(path.resolve(zipPath), {
      dir: path.resolve(extractedDir),
      onEntry: (entry: any) => {
        entryCount += 1;
        if (entryCount > MAX_ENTRIES) throw new Error('ZIP 条目数量超过上限');
        if (!isSafeEntryName(entry?.fileName)) {
          throw new Error(`ZIP 中含非法条目（拒绝 .. 或绝对路径）：${entry?.fileName}`);
        }
        if (isSymlinkEntry(entry)) {
          throw new Error(`ZIP 中含符号链接条目，已拒绝：${entry?.fileName}`);
        }
        totalUncompressed += Number(entry?.uncompressedSize) || 0;
        if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
          throw new Error('ZIP 解压后体积超过上限');
        }
      },
    });

    // ── 2. 读 _name_map.json（导出侧契约） ──
    const mapPath = path.join(extractedDir, '_name_map.json');
    let nameMap: Record<string, string> | null = null;
    if (fs.existsSync(mapPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          nameMap = parsed as Record<string, string>;
        }
      } catch {
        nameMap = null;
      }
    }

    // ── 3. 按原名 staging（只在临时目录内，绝不直接写 addons） ──
    const stagingDir = path.join(tmpRoot, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    const usedNames = new Set<string>();
    const stagedFiles: string[] = [];

    const stageOne = (srcAbs: string, originalName: string): void => {
      let st: fs.Stats;
      try {
        st = fs.statSync(srcAbs);
      } catch {
        return;
      }
      if (!st.isFile()) return;
      // originalName 只取 basename：即使 map 里带了路径也不会越出 staging
      const base = path.basename(String(originalName || '').replace(/\\/g, '/'));
      if (!base || base === '.' || base === '..') return;
      const ext = path.extname(base).toLowerCase();
      if (ext !== '.vpk' && !IMAGE_EXTS.has(ext)) return;
      const lower = base.toLowerCase();
      if (usedNames.has(lower)) return; // 同名只保留第一份
      const dest = path.join(stagingDir, base);
      try {
        fs.copyFileSync(srcAbs, dest);
        usedNames.add(lower);
        stagedFiles.push(dest);
      } catch {
        /* 单个文件复制失败不影响其余 */
      }
    };

    if (nameMap) {
      for (const [archiveName, original] of Object.entries(nameMap)) {
        const safeRel = String(archiveName || '').replace(/\\/g, '/');
        if (!safeRel) continue;
        const srcAbs = path.join(extractedDir, ...safeRel.split('/').filter((s) => s && s !== '.'));
        // 再兜一层：确认解析结果仍在 extractedDir 内
        const rel = path.relative(extractedDir, srcAbs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        stageOne(srcAbs, String(original));
      }
    } else {
      // 没有 _name_map.json（非本产品导出的 ZIP）：按条目自身文件名导入
      for (const entry of fs.readdirSync(extractedDir, { withFileTypes: true })) {
        if (entry.isFile()) stageOne(path.join(extractedDir, entry.name), entry.name);
      }
    }

    if (stagedFiles.length === 0) {
      return fail('ZIP 中没有可导入的 .vpk 或封面文件');
    }

    // ── 4. 复用拖放导入的落盘 + 判重 ──
    const importResult = importDroppedVpks(stagedFiles, addonsPath);

    // ── 5. 收集建包成员：确实存在于 addons 根目录的 vpk 原名 ──
    //   - 新导入 / 同内容已存在（同名或改名重名）都算；
    //   - 同名不同内容（conflicts）没有覆盖原文件，不纳入成员，避免指向错误内容。
    const conflictSet = new Set((importResult.conflicts || []).map((n) => n.toLowerCase()));
    const dupTarget = new Map<string, string>();
    for (const d of importResult.duplicateSources || []) {
      dupTarget.set(String(d.file).toLowerCase(), path.basename(String(d.target)));
    }

    const members: string[] = [];
    const seenMember = new Set<string>();
    for (const staged of stagedFiles) {
      const base = path.basename(staged);
      if (!base.toLowerCase().endsWith('.vpk')) continue;
      if (conflictSet.has(base.toLowerCase())) continue;

      let memberName: string | null = null;
      try {
        if (fs.existsSync(path.join(addonsPath, base))) {
          memberName = base;
        }
      } catch {
        /* ignore */
      }
      if (!memberName) {
        const dup = dupTarget.get(base.toLowerCase());
        if (dup) memberName = dup;
      }
      if (memberName && !seenMember.has(memberName.toLowerCase())) {
        seenMember.add(memberName.toLowerCase());
        members.push(memberName);
      }
    }

    return { ok: true, importResult, members };
  } catch (e: any) {
    console.error('[PackImport] Failed:', e);
    return fail(e?.message || String(e) || '导入整合包失败');
  } finally {
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch (e) {
        console.error('[PackImport] Cleanup failed:', e);
      }
    }
  }
}
