# L4Director

> 《求生之路 2》Mod 管理器 —— 桌面端，一次装几十个 Mod 也不会乱。

L4Director 是一个面向 **Left 4 Dead 2** 的本地 Mod 管理工具。它不只把 `addons` 目录列成一个表，而是真的读懂 VPK 里面装了什么：这个包改了什么资源、和别的包冲不冲突、自己开关有没有和 `addonlist.txt` 对上。

> 当前版本 `1.3.2`，仅支持 Windows。各版本改动见 [CHANGELOG.md](CHANGELOG.md)。

---

## 为什么需要它

L4D2 的 Mod 生态有几个老大难问题：

1. **冲突不可见。** 订阅了 80 个 Mod，游戏里某个动作变成怪模型、某把枪贴图错乱，但你不知道是哪两个包打架。
2. **开关不同步。** 你以为是 `addonlist.txt` 说了算，实际游戏崩溃重启后会把内存里的状态回写，你的勾选被悄悄覆盖。
3. **包内容不透明。** 一个 900 个文件的包里，可能 900 个文件全是官方原版副本，也可能改的只是某把枪的材质——从名字完全看不出来。

L4Director 用逐字节指纹比对来解决这三件事。

## 功能

**扫描与识别**
- 解析 VPK 目录树，得到每个 Mod 实际改了哪些文件
- 自动分到 11 个大类（战役 / 被感染者 / 生还者 / 武器 / 物品 / 界面 / 音效 / 脚本 / 突变 / 皮肤 / 杂项），大类下再按游戏里的英文原名细分出 `Zoey`、`Tank`、`AK-47`、`Medkit` 这一层，选中大类后出现二级筛选行
- 细分按 VPK 内的模型与贴图路径判定（`survivor_teenangst` → Zoey、`hulk` → Tank），不是猜文件名；含 6 种以上武器的包判为合集，只给「武器」大类
- 区分战役地图包与皮肤包，流式扫描逐步出结果

**成员级识别、完整度看板与混搭**
- 卡片上标出替换了清单里的哪几个成员：8 名生还者 / 8 种特感 / 4 件道具 / 35 件武器，形如 `生还者 3/8`、`特感 8/8`（整套为绿色），悬浮能看到具体是谁；筛选栏可只留整套替换的包
- **当前搭配完整度**常驻「我的 Mod」页面：`生还者 8/8 · 特感 6/8 · 物品 0/4 · 武器 18/35`，展开后逐成员列出 —— 彩色 = 已有包在换它（悬浮显示是哪个包），虚框 = 还是原版；右侧「补齐缺口」带着缺口进混搭
- **一键混搭**：每个角色、每把枪**单独**随机挑一个替换包，Nick 有 5 个皮肤就从这 5 个里抽一个，拼出一套互不覆盖的组合。可勾选类别、「换一批」重滚、或只补缺口；应用时只关真正撞车的包，地图 / 音效 / 界面 Mod 不受影响
- 成员级判定同样只看路径：`survivor_namvet.mdl` → Bill、`rifle_ak47` → AK-47，自定义目录（`materials/<作者>/<角色>/`）也认。只有模型与动画、不含任何贴图的公共动画库不算替换 —— 换上去人物外观不变，只是动作变了

**导入**
- 拖放 `.vpk`（或整个文件夹）到窗口直接安装；同名封面图一并复制进 `addons` 并识别为缩略图
- 导入前按「体积 → SHA-256」比对内容：改名后的重复包被拦下，同名但内容不同的不会被覆盖
- 索引范围与游戏一致（`addons/*.vpk` + `addons/workshop/`），装过的再拖一次会被拦下，顺带报告目录里已有的重复包

**重复安装检测**
- 同一个 Mod 既订阅了创意工坊、又把 vpk 拖进 `addons` 根目录时，两份都会被游戏加载
- 按 VPK 目录树（路径 + CRC32 + 长度）比对，内容一致即判重复；标题相同但内容不同的跨来源副本提示「疑似重复（两个版本）」
- 卡片上标 `重复安装`，点开可看两份各自的路径 / 来源 / 启用状态，直接禁用或删除其中一份；启停按 `addonlist` 条目分别记录，禁用一份不会让两份都变灰

**冲突检测**（核心）

把每个 Mod 的文件清单与官方 `pak01_dir.vpk` 的 CRC32 指纹逐条比对，输出五种冲突等级：

| 等级 | 含义 |
|---|---|
| `hard` | 双方都改过同一官方资源且内容不同 —— 真互斥，只能一个生效 |
| `script` | 脚本文件重名，功能可能被顶掉 |
| `copy` | 一方是官方原版副本 —— 单向覆盖，只会抹掉另一方的改动 |
| `entry` | 脚本入口重叠（单实例约定文件） |
| `soft` | 私有路径重名，多为同系列共用素材 |

关键在 `copy` 这一级：很多包会顺手打包一份原版模型当"保险"，这类以前会被误判成冲突。识别出来后直接剔除 —— 实测某次 87 对告警里，真正互斥的只有 1 对。

**开关与同步**
- 批量启用 / 禁用，按分类、标签、搜索筛选后一键操作
- 与 `addonlist.txt` 双向对账，检测「界面状态 vs 游戏文件」不一致并提示
- 检测到游戏退出后的状态回写，把被覆盖的勾选重新应用回去

**创意工坊**
- 自写的工坊浏览器（不内嵌 Steam 网页）：关键词搜索、45 个标签分组筛选（类型 / 角色 / 特感 / 武器 / 模式）、5 种排序、「只看未下载」，卡片带封面、大小、订阅数与好评数 / 累计下载量，点开是详情抽屉，可加入下载队列
- 两条数据源自动切换：填了 Steam API Key 走官方 `QueryFiles`（100 条/页、带评分和精确总数）；没填就抓工坊网页，再用免 key 的详情接口补字段（30 条/页）。**不填 key 也能用**；key 经 Windows DPAPI 加密后只存本机，日志与界面只显示指纹
- 封面不吃性能：卡片只解首帧并按尺寸降采样，动图仅悬停播放、滚到哪加载到哪，一页 100 张卡片稳定在 195~200 FPS；缓存超过 256 MB 按 LRU 回收，单张超过 4 MB 不落盘
- 自动检查已装工坊 Mod 的更新（Steam 公开接口，不需登录或 key），有更新时卡片上标出并可一键更新，覆盖回原文件位置且不改动启停状态
- 检查 / 更新进度在窗口底部常驻条上，切页也看得到，随时可停

**缺 addoninfo 的包**
- 本地 VPK 里没有 `addoninfo.txt` 时，游戏不把它列入「附加内容」，保存 `addonlist.txt` 时还会把它的条目写回启用 —— 界面里关掉、游戏照样加载
- 这类包在卡片上标「缺 addoninfo」，点击可一键补写：解包到同盘临时目录 → 写入最小 `addoninfo.txt` → 重建并逐条校验 → 原子替换，任何一步不符就放弃，原文件全程不动

**坏包不会凭空消失**
- VPK 损坏、被截断、目录树编码异常时，它不会混进 Mod 列表（读不出内容，标签 / 冲突 / 封面全是空的），而是转到列表下方一条常驻提示：文件名、大小、具体错误，加处理办法
- 提示里每条都能「打开所在目录」或「删除文件」—— 文件既然不在列表里，这是软件内唯一的出口；修好后下次扫描自动回到列表

**合辑（Packs）**
- 把一组 Mod 存成合辑，按场景切换整套配置；支持「导入已启用 Mod」直接归集，不改动它们的启停状态

**界面外观**
- 六档主题色（蓝 / 青碧 / 石墨 / 玫红 / 紫罗兰 / 琥珀），标题栏、按钮、选中态、卡片描边和背景氛围光整套跟着换，浅色与深色主题各自取合适明度
- 另有日间 / 夜间主题、界面缩放 100%~150%、界面字体，以及自定义背景图与模糊度

**自动更新**
- 启动 15 秒后静默检查一次（之后每 6 小时一次），发现新版本只在侧边栏版本号旁点一个小圆点，不弹窗打断
- 到「设置 → 关于」点「下载更新」才真正下载，有进度与可取消；装完提示重启并安装，Mod 和配置原样保留
- 走 blockmap 差分，只下载改动过的数据块，通常几 MB；国内直连 GitHub 失败会说明原因，并保留「去 Release 页面手动下载」的出口，也可「跳过这个版本」
- 便携版没有可替换的安装目录，面板会直接说明并给出下载入口

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
│   │   ├── tagger.py              # 标签与成员覆盖判定
│   │   ├── workshop_downloader.py # 工坊下载与详情抓取
│   │   ├── workshop_browse.py     # 工坊浏览/搜索（API + 网页双路）
│   │   ├── workshop_updates.py    # 已装工坊 Mod 的更新检查
│   │   ├── vpk_repair.py          # 缺 addoninfo 的包补写
│   │   └── data_store.py          # 本地持久化
│   └── requirements.txt
├── frontend/
│   └── src/
│       ├── main/                  # Electron 主进程
│       ├── preload/               # 预加载脚本
│       └── renderer/              # React 界面
├── scripts/                       # 基准测试与验证工具
├── docs/                          # 发布说明
├── ld.ps1 / ld.cmd                # 统一启动器
└── LICENSE
```

## 开发

**发版（自动更新所需）**

自动更新走 GitHub Releases，客户端只认三样东西：安装包、`.blockmap`、`latest.yml`。

1. 改 `frontend/package.json` 的 `version`，同步 `CHANGELOG.md`
2. `cd frontend && npm run dist` —— 产物在 `frontend/out/`，文件名由 `build.artifactName` 固定为：
   - `L4Director-Setup-<version>.exe`（安装包）
   - `L4Director-Setup-<version>.exe.blockmap`（差分用）
   - `latest.yml`（版本清单，客户端先读它）
3. 在 GitHub 建 Release，**tag 用 `v<version>`**，三个文件一起传；`latest.yml` 少一个，客户端就当没有更新
4. 或者配好 `GH_TOKEN` 后直接 `npm run release`，打包 + 上传一次做完

**别重命名产物，也别删旧 Release 的资产**：`latest.yml` 里的 `url` 必须与文件名逐字一致；差分下载还要拿上一版的 blockmap 对比，删了就只能全量下载。

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
