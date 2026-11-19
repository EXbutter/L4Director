"""整合包域路由：增删改查、导入导出、整包启停。"""

import json
import tempfile
import urllib.parse
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse

import app_state
from services.data_store import (
    add_mod_to_pack,
    add_mods_to_pack,
    add_pack,
    delete_pack,
    get_packs,
    remove_mod_from_pack,
    remove_mods_from_pack,
    rename_pack,
)
from services.game_process import mark_pending_reapply_if_game_running

router = APIRouter()

@router.post("/api/packs/export")
def export_pack(data: dict):
    """导出整合包为 ZIP 文件"""
    
    pack_name = data.get("packName", "整合包")
    mod_names_input = data.get("modNames", [])
    
    if not mod_names_input:
        raise HTTPException(status_code=400, detail="整合包中没有 Mod")
    
    addons_path = app_state.scanner.get_addons_path()
    if not addons_path:
        raise HTTPException(status_code=400, detail="请先配置 Addons 目录")
    
    addons_dir = Path(addons_path)
    files_to_add = []  # list of (original_path, archive_name)
    files_missing = []
    
    print(f"[Export] Starting export for pack '{pack_name}' with {len(mod_names_input)} mods")
    
    # Get all scanned mods to map display_name -> actual file
    all_mods = app_state.scanner.scan_mods()
    
    for mod_name in mod_names_input:
        found_path = None
        
        # Method 1: 直接按名字拼接（精确路径，不受通配符影响）
        for ext in ['.vpk', '.vpz', '']:
            p = addons_dir / f"{mod_name}{ext}"
            if p.exists() and p.is_file():
                found_path = p
                break
        
        # Method 2: 交给扫描器按名字精确查找（addons 根目录 / workshop / workshop/<id>/）。
        # 不能用 glob：mod 名里的 `[ ]`（例如 `[武器]SCAR.vpk`、`[ 4k  Full HD ]`）
        # 会被 glob 当成字符类，匹配不到真实文件 —— 导出时就会报「找不到文件」。
        if not found_path:
            hit = app_state.scanner.find_mod_file(mod_name)
            if hit:
                found_path = hit[0]
        
        # （原先这里还有一段针对 workshop 目录的 glob 查找，
        #   现已由 Method 2 的精确查找覆盖，故移除）
        
        # Method 4: Use mod info from scanner
        if not found_path:
            mod_info = next((m for m in all_mods if m.name == mod_name), None)
            if mod_info and mod_info.path:
                p = Path(mod_info.path)
                if p.exists() and p.is_file():
                    found_path = p
        
        if found_path:
            files_to_add.append(found_path)
            print(f"[Export] Added: {found_path.name}")
        else:
            files_missing.append(mod_name)
            print(f"[Export] Missing: {mod_name}")
    
    if not files_to_add:
        raise HTTPException(status_code=400, detail=f"未找到任何可导出的 Mod 文件")
    
    # Also add companion thumbnail files (.jpg next to .vpk)
    companion_thumbs = []
    for vpk_path in files_to_add:
        thumb_jpg = vpk_path.with_suffix('.jpg')
        thumb_png = vpk_path.with_suffix('.png')
        if thumb_jpg.exists():
            companion_thumbs.append(thumb_jpg)
        elif thumb_png.exists():
            companion_thumbs.append(thumb_png)
    
    print(f"[Export] Found {len(companion_thumbs)} companion thumbnail files")
    
    # Build name map: archive_name -> original_filename
    name_map = {}
    # Reserve _thumb prefix for thumbnails to keep them paired
    for i, file_path in enumerate(files_to_add, 1):
        name_map[f"mod_{i}{file_path.suffix}"] = file_path.name
    for thumb_path in companion_thumbs:
        # Find which mod this thumbnail belongs to by matching stem
        for i, vpk_path in enumerate(files_to_add, 1):
            if vpk_path.stem == thumb_path.stem:
                name_map[f"mod_{i}_thumb{thumb_path.suffix}"] = thumb_path.name
                break
    
    # 同步生成器（不是 async）：压缩是 CPU 密集 + 磁盘读取，交给 FastAPI 的
    # 线程池迭代，不会堵住事件循环。
    def stream_zip():
        # SpooledTemporaryFile：小于 64MB 时只占内存，超过就自动落到临时文件。
        # 以前是 io.BytesIO + zf.writestr(name, f.read()) —— 每个 VPK 整个读进内存，
        # 一个 3GB 的整合包峰值要 6GB（原文件 + zip 各一份），Electron 直接 OOM。
        with tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024) as spool:
            with zipfile.ZipFile(spool, 'w', zipfile.ZIP_DEFLATED) as zf:
                # Write name mapping
                zf.writestr('_name_map.json', json.dumps(name_map, ensure_ascii=False, indent=2))

                # Write each VPK file（zf.write 由 zipfile 自己分块读源文件）
                for i, file_path in enumerate(files_to_add, 1):
                    archive_name = f"mod_{i}{file_path.suffix}"
                    print(f"[Export] Adding {file_path.name} -> {archive_name}")
                    zf.write(file_path, arcname=archive_name)

                # Write companion thumbnails
                for thumb_path in companion_thumbs:
                    archive_thumb_name = None
                    for i, vpk_path in enumerate(files_to_add, 1):
                        if vpk_path.stem == thumb_path.stem:
                            archive_thumb_name = f"mod_{i}_thumb{thumb_path.suffix}"
                            break
                    if archive_thumb_name:
                        zf.write(thumb_path, arcname=archive_thumb_name)

            spool.seek(0)
            while True:
                chunk = spool.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
    
    encoded_filename = urllib.parse.quote(f"{pack_name}.zip", safe='')
    
    return StreamingResponse(
        stream_zip(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
            "X-Export-Files-Added": str(len(files_to_add)),
            "X-Export-Files-Missing": json.dumps(files_missing),
            "X-Export-Thumbnails": str(len(companion_thumbs)),
        }
    )


# ===== 整合包 CRUD API =====


@router.get("/api/packs")
def list_packs():
    """获取所有整合包"""
    packs = get_packs()
    return {
        "count": len(packs),
        "packs": [{
            "id": p.id,
            "name": p.name,
            "mod_ids": p.mod_ids,
            "created_at": p.created_at,
            "updated_at": p.updated_at,
        } for p in packs]
    }


@router.post("/api/packs")
def create_pack(data: dict):
    """创建新整合包

    `mod_ids` 可选：创建时直接带上成员，供「把已启用的 Mod 一键导入新整合包」使用。
    带成员创建只需要一次读写盘，也不会出现「包建好了但 Mod 没进去」的半成品。
    """
    name = data.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="整合包名称不能为空")
    raw_mods = data.get("mod_ids")
    mod_ids = [str(m) for m in raw_mods] if isinstance(raw_mods, list) else None
    pack = add_pack(name, mod_ids)
    return {
        "status": "ok",
        "pack": {
            "id": pack.id,
            "name": pack.name,
            "mod_ids": pack.mod_ids,
            "created_at": pack.created_at,
            "updated_at": pack.updated_at,
        }
    }


@router.delete("/api/packs/{pack_id}")
def delete_pack_api(pack_id: str):
    """删除整合包"""
    success = delete_pack(pack_id)
    if not success:
        raise HTTPException(status_code=404, detail="整合包未找到")
    return {"status": "ok"}


@router.put("/api/packs/{pack_id}")
def update_pack(pack_id: str, data: dict):
    """更新整合包（重命名或修改内容）"""
    # Check rename
    if "name" in data:
        new_name = data["name"].strip()
        if new_name:
            if not rename_pack(pack_id, new_name):
                raise HTTPException(status_code=404, detail="整合包未找到")

    # Check add/remove mods
    # 同时支持单个与批量：批量走 *_mods 数组，只写一次盘（避免逐个请求导致
    # 界面停在「只加进去一部分」的中间状态）
    if isinstance(data.get("add_mods"), list):
        add_mods_to_pack(pack_id, [str(m) for m in data["add_mods"]])
    if isinstance(data.get("remove_mods"), list):
        remove_mods_from_pack(pack_id, [str(m) for m in data["remove_mods"]])
    if "add_mod" in data:
        add_mod_to_pack(pack_id, data["add_mod"])
    if "remove_mod" in data:
        remove_mod_from_pack(pack_id, data["remove_mod"])

    # Return updated pack
    packs = get_packs()
    pack = next((p for p in packs if p.id == pack_id), None)
    if not pack:
        raise HTTPException(status_code=404, detail="整合包未找到")
    return {
        "status": "ok",
        "pack": {
            "id": pack.id,
            "name": pack.name,
            "mod_ids": pack.mod_ids,
            "created_at": pack.created_at,
            "updated_at": pack.updated_at,
        }
    }


# ===== 整合包批量启用/禁用 API =====


@router.post("/api/packs/{pack_id}/toggle")
def toggle_pack(pack_id: str, data: dict):
    """一次性启用/禁用整个整合包里的所有 Mod。

    前端以前是逐个调用 /api/mods/{name}/toggle：后端每个 Mod 都要「读 addonlist
    → 写 addonlist → 重新解析 VPK」，几百个 Mod 的整合包会卡住很久，界面也没有反馈。
    这里合并成一次读写。
    """
    packs = get_packs()
    pack = next((p for p in packs if p.id == pack_id), None)
    if not pack:
        raise HTTPException(status_code=404, detail="整合包未找到")

    # enable 不传（或为 null）表示「切换」：由后端按成员真实状态决定目标方向，
    # 避免前端因为成员名匹配不上而算错方向 —— 表现就是「一键启用/禁用点了没反应」。
    raw_enable = data.get("enable", None)
    enable = None if raw_enable is None else bool(raw_enable)

    if not pack.mod_ids:
        return {"status": "ok", "enable": bool(enable), "changed": 0, "missing": [], "updated": {}}

    result = app_state.scanner.set_mods_enabled(list(pack.mod_ids), enable)
    # 同单个启停：游戏运行期间的改动会被游戏退出时写回的内存状态覆盖，
    # 标记一下，等游戏退出后自动以软件设置为准重新写回
    mark_pending_reapply_if_game_running()
    return {
        "status": "ok",
        "enable": result.get("enable"),
        "changed": result.get("changed", 0),
        "missing": result.get("missing", []),
        # 实际生效的「成员名 -> 启用状态」：前端用它做局部更新，
        # 从而不需要在每次启停后重新扫描一遍全部 Mod
        "updated": result.get("updated", {}),
    }
