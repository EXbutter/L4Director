# L4Director

> 《求生之路 2》Mod 管理器 —— 桌面端，一次装几十个 Mod 也不会乱。

L4Director 是一个面向 **Left 4 Dead 2** 的本地 Mod 管理工具。它不只把 `addons` 目录列成一个表，而是真的读懂 VPK 里面装了什么：这个包改了什么资源、和别的包冲不冲突、自己开关有没有和 `addonlist.txt` 对上。

> 当前版本 `1.3.1`，仅支持 Windows。各版本改动见 [CHANGELOG.md](CHANGELOG.md)。

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
- 自写的工坊浏览器（不再内嵌 Steam 网页）：关键词搜索、50 个真实标签分组筛选（类型 / 角色 / 特感 / 武器 / 模式）、5 种排序、「只看未下载」，卡片带封面、大小、订阅数与好评率，点开是详情抽屉，可一键加入下载队列
- 两条数据源自动切换：设置里填了 Steam API Key 就走官方 `QueryFiles`（100 条/页、带评分、有精确总数）；没填就抓工坊网页拿列表、再用免 key 的详情接口补字段（30 条/页）。**不填 key 也能完整使用**
- 封面不吃性能：工坊封面里混着单张 28 MB 的 GIF 动图，直接塞 `<img>` 实测整页只有 16 FPS。现在卡片走「只解第一帧 + 按卡片尺寸降采样」的静态图，动图**只在鼠标悬停时播**（一次一张），并且滚到哪加载到哪 —— 一页 100 张卡片稳定 195~200 FPS；封面缓存超过 256 MB 自动回收，单张超过 4 MB 不落盘
- 缩略图抓取与格式转换（VTF/BMP → 可直接显示的图片）；封面本身是 GIF / 动图时**进入视口即自动播放**（滚出即停），不带角标、卡片外观与普通封面一致 —— 逐帧解码 + 帧数与位图双上限 + 播放节奏锁在刷新网格上，帧率波动压在 10% 以内，整墙滚动不掉帧
- 自动检查已装工坊 Mod 是否有更新（走 Steam 公开接口，不需要登录或 API key），有更新时在卡片上标出并可一键更新；下载覆盖回原文件位置，不改动启停状态
- 检查/更新进度显示在窗口底部常驻条上，切成任何页面都看得到；更新过程中可以随时「停止」（已下完的保留，当前文件在分块边界退出）

**缺 addoninfo 的包**
- 本地 VPK 里没有 `addoninfo.txt` 时，游戏不会把它列入「附加内容」，保存 `addonlist.txt` 时还会把它的条目写回启用 —— 界面里关掉、游戏照样加载
- 这类包在卡片上标「缺 addoninfo」，点击可一键补写：解包到同盘临时目录 → 写入最小 `addoninfo.txt` → 重建并逐条目校验 → 原子替换，任何一步不符就放弃，原文件全程不被改动

**坏包不会凭空消失**
- VPK 损坏、被截断、目录树编码异常时，它不会混进 Mod 列表（读不出内容，标签 / 分类 / 冲突 / 封面都是空的，留着只会让人以为多了个能用的包），而是转到列表下方一条常驻提示里：文件名、大小、具体错误原因，加四步处理办法
- 提示里每条都能「打开所在目录」定位到文件，或「删除文件」清掉它 —— 文件既然不在列表里，这两个按钮就是软件内唯一的出口
- 修好之后下次扫描会自动回到列表，不需要重启

**合辑（Packs）**
- 把一组 Mod 存成合辑，按场景快速切换整套配置
- **一键把当前已启用的 Mod 收进新合辑**：点「导入已启用 Mod」→ 命名 → 直接进详情页；只做归集，不改动这些 Mod 的启停状态

**界面外观**
- 六档主题色：默认蓝 / 青碧 / 石墨（冷色、工具感）+ 玫红 / 紫罗兰 / 琥珀（暖色、氛围感）。标题栏、按钮、选中态、卡片描边和背景氛围光整套跟着换
- 色卡显示的色就是界面上实际用的色（相对亮度都落在 0.13~0.30，暗色主题不会被提亮、亮色主题不会被压暗），日间/夜间各自取合适明度，不用手动调
- 另有日间/夜间主题、界面缩放 100%~150%、界面字体，以及自定义背景图与背景模糊度

**自动更新**
- 启动 15 秒后在后台静默检查一次（之后每 6 小时一次），发现新版本只在侧边栏版本号旁点一个小圆点，不弹窗打断
- 到「设置 → 关于」点「下载更新」才真正下载，有进度条与速度、可随时取消；下载完提示「重启并安装」，重启后自动装好，Mod 和配置原样保留
- 走 blockmap 差分：只下载改动过的数据块，通常几 MB，不用再拖 85 MB 的完整安装包
- 国内直连 GitHub 失败时给出明确原因（连接被拒 / 超时 / 解析失败），并保留「去 Release 页面手动下载」的出口；可以「跳过这个版本」，下个版本照常提醒
- 便携版（portable）没有安装目录可替换，面板会直接说明并给出下载入口，不会点了没反应

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
├── data.json            # 全部状态：Mod 元数据 / 合辑 / 设置 / 扫描清单 / addonlist 指纹
├── data.json.bak        # 上一次写盘前的快照（误操作时的回滚点）
├── data.json.corrupt-*  # 极端情况下才会出现：data.json 解析失败时原文件被挪到这里
├── config.json          # addons 路径（历史遗留的独立配置，读取时优先于 data.json）
├── recovery.log         # 上面两种异常的文字记录
├── vpk_index/           # VPK 指纹索引缓存（冲突检测用，按源文件 mtime 失效）
├── vpk_metadata/        # 从 VPK 内部提取的标题 / 作者 / 封面等元数据
├── manifests/           # VPK 目录树清单缓存
└── vpk_covers/          # 从 VPK 里提取出来的封面图
```

> 早期文档把 mod_meta / packs / scan_manifest 写成三个独立文件，**实际全部合并在
> `data.json` 里**（这样一次原子写就能保证它们互相一致）。手工备份只需要拷
> `data.json`；把它删掉等同于恢复默认设置，Mod 文件本身不受影响。

缓存里那三个目录（`vpk_index` / `vpk_metadata` / `manifests`）和 `vpk_covers` 会在
Mod 被更新或删除后留下不再被引用的旧条目。设置 → 性能 → 「本地缓存」显示当前占用，
点「清理缓存」只删除**对应 Mod 已经不存在**的那部分，不动任何 Mod 文件与启停状态。

## 目录结构

```
L4D2 Manager/
├── backend/
│   ├── main.py                    # FastAPI 入口与路由
│   ├── services/
│   │   ├── mod_scanner.py         # 扫描、开关、addonlist 同步
│   │   ├── conflict_engine.py     # 冲突检测与官方指纹索引
│   │   ├── tagger.py              # 标签判定规则
│   │   ├── workshop_downloader.py # 创意工坊下载与详情抓取
│   │   ├── workshop_browse.py     # 工坊浏览/搜索（API + 网页双路）
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

**发版（自动更新所需）**

自动更新走 GitHub Releases，客户端只认三样东西：安装包、`.blockmap`、`latest.yml`。

1. 改 `frontend/package.json` 的 `version`（例如 `1.2.0` → `1.3.0`），同步 `CHANGELOG.md`
2. `cd frontend && npm run dist` —— 产物在 `frontend/out/`，共三个文件：
   - `L4Director Setup 1.3.0.exe`（安装包）
   - `L4Director Setup 1.3.0.exe.blockmap`（差分用）
   - `latest.yml`（版本清单，客户端先读它）
3. 在 GitHub 建 Release，**tag 用 `v1.3.0`**，把上面三个文件传上去。手动上传时注意：
   - 两个 exe/blockmap 要改名成 `L4Director-Setup-1.3.0.exe` 和同名的 `.blockmap`（连字符，不是空格），必须与 `latest.yml` 里 `url` 字段完全一致，否则客户端 404
   - `latest.yml` 不能忘，缺了它客户端会认为「没有可用更新」
4. 或者配好 `GH_TOKEN` 后直接 `npm run release`，打包 + 上传一次做完

发版后不要删旧 Release 的资产：差分下载需要拿上一版的 blockmap 对比，删了就只能全量下载。

**性能基准**

```powershell
cd frontend
npm run bench:scan         # 完整扫描基准
npm run bench:scan:quick   # 快速模式
npm run bench:startup      # 冷启动耗时
```

基准结果会写到 `backend/bench_baseline_*.json`，改动扫描逻辑后建议对比一次。

**验证脚本**

`scripts/` 下有若干 `verify_*.py`，针对具体行为做端到端校验（addonlist 同步、游戏退出后重应用、缩略图转码、标签与冲突结果、数据文件安全性等）。它们依赖本机真实的游戏目录，属于开发期自检工具，不是可移植的单元测试。

跑全部：

```powershell
python scripts/run_all_verify.py        # 串行执行并汇总
python scripts/run_all_verify.py -v     # 同时打印每个脚本的完整输出
python scripts/run_all_verify.py lru    # 只跑文件名含关键字的那些
```

**当前状态说明**

- 没有 pytest / vitest 测试套件，也没有 CI
- `backend/main.py` 目前是单文件，后续会按域拆成 router
- 界面文案为中文，暂无 i18n

欢迎在 Issue 里指出问题，或直接提 PR。

## 免责声明

本项目与 Valve Corporation 无关联。`Left 4 Dead 2` 及相关资源版权归 Valve 所有。工具仅操作你本机已有的 Mod 文件，不提供、不分发任何游戏资源。

## 许可证

[GPL-3.0](LICENSE)
