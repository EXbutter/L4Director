# L4Director

> 《求生之路 2》Mod 管理器 —— 桌面端，一次装几十个 Mod 也不会乱。

L4Director 是一个面向 **Left 4 Dead 2** 的本地 Mod 管理工具。它不只把 `addons` 目录列成一个表，而是真的读懂 VPK 里面装了什么：这个包改了什么资源、和别的包冲不冲突、自己开关有没有和 `addonlist.txt` 对上。

> 当前版本 `1.1.0`，仅支持 Windows。

<!-- 建议在此处补 2-3 张界面截图，放在 docs/screenshots/ 下，替换下面这行 -->
<!-- ![主界面](docs/screenshots/main.png) -->

---

## 为什么需要它

L4D2 的 Mod 生态有几个老大难问题：

1. **冲突不可见。** 订阅了 80 个 Mod，游戏里某个动作变成怪模型、某把枪贴图错乱，但你不知道是哪两个包打架。
2. **开关不同步。** 你以为是 `addonlist.txt` 说了算，实际游戏崩溃重启后会把内存里的状态回写，你的勾选被悄悄覆盖。
3. **包内容不透明。** 一个 900 个文件的包里，可能 900 个文件全是官方原版副本，也可能改的只是某把枪的材质——从名字完全看不出来。

L4Director 用逐字节指纹比对来解决这三件事。

## 功能

**扫描与识别**
- 解析 VPK 目录树，提取每个 Mod 实际改动的文件清单
- 自动分类到 11 个大类：战役 / 被感染者 / 生还者 / 武器 / 物品 / 游戏界面 / 音效 / 脚本 / 突变模式 / 皮肤 / 杂项
- 大类下再细分一层，细分一律用游戏里的英文原名，而不是「步枪 / 冲锋枪」这种归类词：生还者（Zoey / Nick / Bill……）、被感染者（Tank / Witch / Boomer……）、武器（AK-47 / M16 Rifle / Hunting Rifle / Katana / Chainsaw……）、物品（Medkit / Pain Pills / Adrenaline / Defibrillator）；选中大类后会出现二级筛选行
- 细分标签按 VPK 内的模型与贴图路径判定（`survivor_teenangst` → Zoey、`hulk` → Tank、`rifle_ak47` → AK-47），不是按文件名猜；包内含 6 种以上武器时判为武器合集，只给「武器」大类，不挑两个型号出来以偏概全
- 区分「战役地图包」与「皮肤包」这类容易混淆的形态（读 `addoninfo` + 路径特征）
- 流式扫描，大目录下逐步出结果，不用等整体扫完

**导入**
- 拖放 `.vpk`（或整个文件夹）到窗口直接安装；与 vpk 同名的封面图会一并复制进 `addons`，并自动识别为缩略图
- 导入前按「体积 → SHA-256」比对内容：改名后的重复 Mod 会被拦下，同名但内容不同的文件不会被覆盖
- 索引范围与游戏实际加载规则一致（`addons/*.vpk` + `addons/workshop/`），已经装过的包再拖一次会被拦下
- 顺带报告 `addons` 里已经存在的重复包（内容相同、文件名不同）

**重复安装检测**
- 同一个 Mod 既订阅了创意工坊、又把 vpk 拖进了 `addons` 根目录时，两份都会被游戏加载：列表里两条同名条目、内存里两份资源
- 按 VPK 目录树（路径 + CRC32 + 长度）比对，内容逐条一致即判定重复；标题相同、内容不同的跨来源副本提示「疑似重复（两个版本）」
- 卡片上标 `重复安装`，点开可看两份各自的路径 / 来源 / 启用状态，直接禁用或删除其中一份
- 同名副本的启停互不影响：偏好按 `addonlist` 条目分别记录，不会出现「禁用一份、两份都变灰」

**冲突检测**（核心）

把每个 Mod 的文件清单与官方 `pak01_dir.vpk` 的 CRC32 指纹逐条比对，输出五种冲突等级：

| 等级 | 含义 |
|---|---|
| `hard` | 双方都改过同一官方资源且内容不同 —— 真互斥，只能一个生效 |
| `script` | 脚本文件重名，功能可能被顶掉 |
| `copy` | 一方是官方原版副本 —— 单向覆盖，只会抹掉另一方的改动 |
| `entry` | 脚本入口重叠（单实例约定文件） |
| `soft` | 私有路径重名，多为同系列共用素材 |

关键在 `copy` 这一级：很多包会顺手打包一份原版模型当"保险"，以前这类会被误判成冲突。现在识别出来后直接剔除，避免把噪音当结论——实测某次 87 对告警里，99% 是噪音，真正互斥的只有 1 对。

**开关与同步**
- 批量启用 / 禁用，按分类、标签、搜索筛选后一键操作
- 与 `addonlist.txt` 双向对账，检测「界面状态 vs 游戏文件」不一致并提示
- 检测到游戏退出后的状态回写，把被覆盖的勾选重新应用回去

**创意工坊**
- 搜索、浏览、下载工坊内容到本地 `addons`
- 缩略图抓取与格式转换（VTF/BMP → 可直接显示的图片）
- 自动检查已装工坊 Mod 是否有更新（走 Steam 公开接口，不需要登录或 API key），有更新时在卡片上标出并可一键更新；下载覆盖回原文件位置，不改动启停状态
- 检查/更新进度显示在窗口底部常驻条上，切成任何页面都看得到

**缺 addoninfo 的包**
- 本地 VPK 里没有 `addoninfo.txt` 时，游戏不会把它列入「附加内容」，保存 `addonlist.txt` 时还会把它的条目写回启用 —— 界面里关掉、游戏照样加载
- 这类包在卡片上标「缺 addoninfo」，点击可一键补写：解包到同盘临时目录 → 写入最小 `addoninfo.txt` → 重建并逐条目校验 → 原子替换，任何一步不符就放弃，原文件全程不被改动

**合辑（Packs）**
- 把一组 Mod 存成合辑，按场景快速切换整套配置

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 28 |
| 界面 | React 18 + TypeScript（`strict`）+ Zustand + Sass |
| 构建 | Vite 5 |
| 后端 | Python 3.10+ / FastAPI / Uvicorn |
| 打包 | electron-builder（NSIS） |

前后端分离：Electron 主进程拉起本地 Python 服务（默认 `127.0.0.1:8288`），渲染进程通过 HTTP 调它。这样 VPK 解析这类重活可以放在 Python 侧做，界面不会卡。

## 快速开始

**前置要求**

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 18 或更高
- [Python](https://www.python.org/) 3.10 或更高（代码用到 `X | None` 类型语法）

**安装**

```powershell
git clone https://github.com/EXbutter/L4Director.git "L4D2 Manager"
cd "L4D2 Manager"

# 后端依赖
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt

# 前端依赖
cd frontend
npm install
cd ..
```

**运行**

```powershell
.\ld run
```

会同时启动 Vite 开发服务器（`:5173`）和 Electron 窗口，后端由主进程并行拉起（`:8288`）。按 `Ctrl+C` 一次性停掉全部服务。

只想起后端调试 API：

```powershell
.\ld backend
```

> `ld backend` 直接调用 PATH 上的 `python`。如果你用虚拟环境，请先激活再执行。

其他命令：`.\ld help`

**首次使用**

打开后在「设置」里确认 `addons` 目录。通常会自动识别到：

```
<Steam 库>\steamapps\common\Left 4 Dead 2\left4dead2\addons
```

识别不到就手动指定一次，之后不再问。

## 数据存放

状态和缓存都在用户目录，不污染仓库：

```
~/.l4d2-manager/
├── packs.json           # 合辑配置
├── mod_meta.json        # 显示名、自定义标签
├── scan_manifest.json   # 扫描清单
└── vpk_index/           # VPK 指纹索引缓存（按源文件 mtime 失效）
```

删掉整个目录等同于恢复默认设置，Mod 文件本身不受影响。

## 目录结构

```
L4D2 Manager/
├── backend/
│   ├── main.py                    # FastAPI 入口与路由
│   ├── services/
│   │   ├── mod_scanner.py         # 扫描、开关、addonlist 同步
│   │   ├── conflict_engine.py     # 冲突检测与官方指纹索引
│   │   ├── tagger.py              # 标签判定规则
│   │   ├── workshop_downloader.py # 创意工坊抓取
│   │   └── data_store.py          # 本地持久化
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── main/                  # Electron 主进程
│       ├── preload/               # 预加载脚本
│       └── renderer/              # React 界面
├── scripts/                       # 基准测试与验证工具
├── ld.ps1 / ld.cmd                # 统一启动器
└── LICENSE
```

## 开发

**性能基准**

```powershell
cd frontend
npm run bench:scan         # 完整扫描基准
npm run bench:scan:quick   # 快速模式
npm run bench:startup      # 冷启动耗时
```

基准结果会写到 `backend/bench_baseline_*.json`，改动扫描逻辑后建议对比一次。

**验证脚本**

`scripts/` 下有若干 `verify_*.py`，针对具体行为做端到端校验（addonlist 同步、游戏退出后重应用、缩略图转码、标签与冲突结果等）。它们依赖本机真实的游戏目录，属于开发期自检工具，不是可移植的单元测试。

**当前状态说明**

- 没有 pytest / vitest 测试套件，也没有 CI
- `backend/main.py` 目前是单文件，后续会按域拆成 router
- 界面文案为中文，暂无 i18n

欢迎在 Issue 里指出问题，或直接提 PR。

## 免责声明

本项目与 Valve Corporation 无关联。`Left 4 Dead 2` 及相关资源版权归 Valve 所有。工具仅操作你本机已有的 Mod 文件，不提供、不分发任何游戏资源。

## 许可证

[GPL-3.0](LICENSE)
