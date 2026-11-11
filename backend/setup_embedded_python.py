"""
嵌入式 Python 设置脚本
从 Python 官网下载 embeddable Python，安装 pip 和后端依赖

用法：
    python setup_embedded_python.py

原理：
    1. 下载 Python embeddable 版本到 backend/embedded_python/
    2. 解压并配置 pip
    3. 安装 requirements.txt 中的依赖到嵌入式环境
"""

import os
import sys
import urllib.request
import zipfile
import subprocess
import shutil
import json
import tempfile
from pathlib import Path

EMBEDDED_DIR = Path(__file__).parent / "embedded_python"
REQUIREMENTS_FILE = Path(__file__).parent / "requirements.txt"

# Python 版本配置 - 使用 3.12.x 稳定版（兼容性最好）
PYTHON_VERSION = "3.12.4"
PYTHON_EMBEDDED_URL = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/"
    f"python-{PYTHON_VERSION}-embed-amd64.zip"
)
# get-pip.py 下载地址
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"


def download_file(url: str, dest: Path) -> None:
    """下载文件并显示进度"""
    print(f"📥 正在下载: {url}")
    
    def report_progress(block_num: int, block_size: int, total_size: int):
        if total_size > 0:
            downloaded = block_num * block_size / 1024 / 1024
            total = total_size / 1024 / 1024
            print(f"  进度: {downloaded:.1f} / {total:.1f} MB", end="\r")
    
    urllib.request.urlretrieve(url, str(dest), report_progress)
    print(f"\n✅ 下载完成: {dest.name}")


def download_and_extract_embeddable() -> bool:
    """下载并解压嵌入式 Python"""
    if EMBEDDED_DIR.exists():
        print(f"📂 嵌入式 Python 目录已存在: {EMBEDDED_DIR}")
        overwrite = input("是否重新下载并覆盖？(y/N): ").strip().lower()
        if overwrite != 'y':
            print("⏭️ 跳过下载，使用现有嵌入式 Python")
            return True
        shutil.rmtree(EMBEDDED_DIR)
    
    EMBEDDED_DIR.mkdir(parents=True, exist_ok=True)
    
    # 下载嵌入式 Python
    zip_path = EMBEDDED_DIR / f"python-{PYTHON_VERSION}-embed-amd64.zip"
    try:
        download_file(PYTHON_EMBEDDED_URL, zip_path)
    except Exception as e:
        print(f"❌ 下载失败: {e}")
        print("💡 可以手动下载后放入 backend/embedded_python/ 目录")
        print(f"   下载地址: {PYTHON_EMBEDDED_URL}")
        return False
    
    # 解压
    print(f"📦 正在解压到 {EMBEDDED_DIR}...")
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(str(EMBEDDED_DIR))
    
    # 删除压缩包
    zip_path.unlink()
    
    # 确认 python.exe 存在
    python_exe = EMBEDDED_DIR / "python.exe"
    if not python_exe.exists():
        print(f"❌ 解压后未找到 python.exe，嵌入式 Python 可能不完整")
        return False
    
    print(f"✅ 嵌入式 Python 解压完成")
    return True


def setup_pip() -> bool:
    """为嵌入式 Python 安装 pip"""
    python_exe = EMBEDDED_DIR / "python.exe"
    
    # 1. 修改 python._pth 文件，取消 site-packages 的注释
    #    (嵌入式 Python 默认不加载 site-packages)
    pth_files = list(EMBEDDED_DIR.glob("python*._pth"))
    if not pth_files:
        print("⚠️ 未找到 python._pth 文件，尝试手动创建")
        pth_file = EMBEDDED_DIR / f"python{PYTHON_VERSION.rsplit('.', 1)[0]}._pth"
    else:
        pth_file = pth_files[0]
    
    print(f"📝 修改 {pth_file.name} 启用 site-packages...")
    with open(pth_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 取消 import site 的注释（如果有的话）
    if '#import site' in content:
        content = content.replace('#import site', 'import site')
        with open(pth_file, 'w', encoding='utf-8') as f:
            f.write(content)
        print("✅ 已启用 site-packages 导入")
    else:
        print("ℹ️ 似乎已经配置好了")
    
    # 2. 下载 get-pip.py
    print("📥 正在下载 get-pip.py...")
    get_pip_path = EMBEDDED_DIR / "get-pip.py"
    try:
        download_file(GET_PIP_URL, get_pip_path)
    except Exception as e:
        print(f"❌ 下载 get-pip.py 失败: {e}")
        print("💡 可以手动下载 https://bootstrap.pypa.io/get-pip.py 放置到 backend/embedded_python/")
        return False
    
    # 3. 安装 pip
    print("🔧 正在安装 pip...")
    result = subprocess.run(
        [str(python_exe), str(get_pip_path)],
        capture_output=True, text=True, cwd=str(EMBEDDED_DIR)
    )
    print(result.stdout)
    if result.returncode != 0:
        print(f"❌ pip 安装失败: {result.stderr}")
        return False
    
    # 清理 get-pip.py
    get_pip_path.unlink()
    
    # 验证 pip
    result = subprocess.run(
        [str(python_exe), "-m", "pip", "--version"],
        capture_output=True, text=True, cwd=str(EMBEDDED_DIR)
    )
    if result.returncode == 0:
        print(f"✅ pip 安装成功: {result.stdout.strip()}")
        return True
    else:
        print(f"❌ pip 验证失败")
        return False


def install_dependencies() -> bool:
    """安装 requirements.txt 中的依赖"""
    if not REQUIREMENTS_FILE.exists():
        print(f"⚠️ 未找到 {REQUIREMENTS_FILE}")
        return True  # 没有依赖也没关系
    
    python_exe = EMBEDDED_DIR / "python.exe"
    print(f"📦 正在安装后端依赖...")
    
    result = subprocess.run(
        [str(python_exe), "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)],
        capture_output=True, text=True, cwd=str(EMBEDDED_DIR)
    )
    
    # 输出 pip 的详细日志
    for line in result.stdout.split('\n'):
        if line.strip():
            print(f"   {line}")
    
    if result.returncode != 0:
        print(f"❌ 依赖安装失败: {result.stderr}")
        # 尝试逐个安装
        print("🔄 尝试逐个安装依赖...")
        with open(REQUIREMENTS_FILE, 'r', encoding='utf-8') as f:
            packages = [line.strip() for line in f if line.strip() and not line.startswith('#')]
        
        all_ok = True
        for pkg in packages:
            print(f"  安装 {pkg}...")
            r = subprocess.run(
                [str(python_exe), "-m", "pip", "install", pkg],
                capture_output=True, text=True, cwd=str(EMBEDDED_DIR)
            )
            if r.returncode != 0:
                print(f"  ❌ {pkg} 安装失败: {r.stderr}")
                all_ok = False
            else:
                print(f"  ✅ {pkg} 安装成功")
        
        return all_ok
    
    # 验证关键包
    print("🔍 验证安装的包...")
    result = subprocess.run(
        [str(python_exe), "-c", "import fastapi; print(f'fastapi: {fastapi.__version__}')"],
        capture_output=True, text=True, cwd=str(EMBEDDED_DIR)
    )
    if result.returncode == 0:
        print(f"   ✅ {result.stdout.strip()}")
    else:
        print(f"   ❌ fastapi 导入失败: {result.stderr}")
        return False
    
    result = subprocess.run(
        [str(python_exe), "-c", "import uvicorn; print(f'uvicorn: {uvicorn.__version__}')"],
        capture_output=True, text=True, cwd=str(EMBEDDED_DIR)
    )
    if result.returncode == 0:
        print(f"   ✅ {result.stdout.strip()}")
    else:
        print(f"   ❌ uvicorn 导入失败: {result.stderr}")
        return False
    
    return True


def show_summary():
    """显示配置总结"""
    python_exe = EMBEDDED_DIR / "python.exe"
    
    print("\n" + "=" * 50)
    print("📋 嵌入式 Python 配置完成")
    print("=" * 50)
    
    # 版本信息
    result = subprocess.run(
        [str(python_exe), "--version"],
        capture_output=True, text=True
    )
    print(f"  Python: {result.stdout.strip()}")
    
    # pip 版本
    result = subprocess.run(
        [str(python_exe), "-m", "pip", "--version"],
        capture_output=True, text=True
    )
    print(f"  pip: {result.stdout.strip()}")
    
    # 已安装的包
    print(f"  路径: {EMBEDDED_DIR}")
    
    # 计算大小
    total_size = sum(
        f.stat().st_size for f in EMBEDDED_DIR.rglob('*') if f.is_file()
    )
    size_mb = total_size / 1024 / 1024
    print(f"  总大小: {size_mb:.1f} MB")
    
    print("=" * 50)
    print("💡 你现在可以重新打包 L4Director 了！")
    print("   嵌入版 Python 会被自动包含在安装包中。")
    print("=" * 50)


def main():
    print("🚀 L4Director 嵌入式 Python 配置工具")
    print("=" * 50)
    
    # 步骤 1：下载并解压嵌入式 Python
    if not download_and_extract_embeddable():
        print("\n❌ 下载失败，请尝试手动下载")
        return
    
    # 步骤 2：配置 pip
    if not setup_pip():
        print("\n⚠️ pip 配置失败，但嵌入式 Python 仍可使用")
        print("   你需要手动安装依赖：")
        print(f"   cd {EMBEDDED_DIR}")
        print(f"   python get-pip.py")
        print(f"   python -m pip install -r {REQUIREMENTS_FILE}")
        return
    
    # 步骤 3：安装依赖
    if not install_dependencies():
        print("\n⚠️ 部分依赖安装失败")
        print("   你可以稍后手动安装缺失的包")
    
    # 显示总结
    show_summary()


if __name__ == "__main__":
    main()
