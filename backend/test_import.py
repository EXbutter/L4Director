"""Test import of data_store and mod_scanner"""
print("Testing imports...")

from services.data_store import (
    get_settings, get_setting, set_setting, get_mod_category, set_mod_category,
    get_packs, add_pack, delete_pack,
    ModMeta, PackData
)
print("✅ data_store import OK")

from services.mod_scanner import ModScanner, ModInfo, _get_metadata
print("✅ mod_scanner import OK")

# Test data_store basic ops
print("Testing data store operations...")
set_setting("test_key", "test_value")
val = get_setting("test_key")
assert val == "test_value", f"Expected test_value, got {val}"
print("✅ Setting/Getting works")

# Test category ops
set_mod_category("test_mod.vpk", "地图")
cat = get_mod_category("test_mod.vpk")
assert cat == "地图", f"Expected 地图, got {cat}"
print("✅ Category override works")
set_mod_category("test_mod.vpk", None)
cat = get_mod_category("test_mod.vpk")
assert cat is None, f"Expected None, got {cat}"
print("✅ Category clear works")

# Test pack ops
pack = add_pack("测试整合包")
assert pack.name == "测试整合包"
packs = get_packs()
assert any(p.id == pack.id for p in packs)
print("✅ Pack creation works")

delete_pack(pack.id)
packs = get_packs()
assert not any(p.id == pack.id for p in packs)
print("✅ Pack deletion works")

print("\n🎉 All tests passed!")
