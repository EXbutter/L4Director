# 测试与性能预算

后端 pytest、前端 vitest、CI 门禁都在这里。完整的性能要求与量级阈值（含「多少 Mod 该做虚拟化」）
记在维护者的内部规格 `docs-internal/09-性能与测试规格.md`，本文是**能直接照着跑**的那一份。

## 一次性准备

```bash
# 后端（Python 3.10+，推荐与内置 Python 同版本）
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt -r backend/requirements-dev.txt

# 前端
cd frontend
npm ci
```

> `requirements-dev.txt` 里的 `httpx` 必须 <0.28：Starlette 0.35 的 `TestClient(app=...)`
> 在 0.28 之后改成了 `transport=`，装高了所有接口测试会在收集阶段就崩。

## 跑测试

```bash
# 后端：功能用例（约 8s）
.venv\Scripts\python.exe -m pytest

# 后端：只跑性能预算（约 10s，会生成上百个合成 VPK）
.venv\Scripts\python.exe -m pytest -m perf

# 后端：跳过性能预算（弱机器 / 快速迭代）
.venv\Scripts\python.exe -m pytest -m "not perf"

# 前端：单元测试（约 1.5s，6 个文件 / 58 用例）
cd frontend && npx vitest run
cd frontend && npx vitest          # watch 模式

# 注意：frontend/package.json 没有 "test" 脚本，`npm test` 会报 Missing script。
# 想让它重新成立，需要加 "test": "vitest run"（待决策，见 docs-internal/09 §五）

# 类型检查（两套 tsconfig：渲染层 / 主进程+preload）
cd frontend && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.main.json

# 发版前的白盒验证（24 个脚本，跑在独立进程 + 临时 HOME 上）
.venv\Scripts\python.exe scripts\run_all_verify.py
```

## 测试放在哪

| 目录 | 内容 |
|---|---|
| `backend/tests/test_data_store.py` | 数据安全：原子写、上一版备份、损坏隔离、只读模式、批量只写一次 |
| `backend/tests/test_conflict_engine.py` | 冲突五档（hard/script/copy/entry/soft）与角色识别 |
| `backend/tests/test_scanner.py` | 合成 VPK 扫描、工坊包、同名双份、缓存命中、toggle 落盘、补 addoninfo、流式事件 |
| `backend/tests/test_media_types.py` | 图片 MIME（文件头优先） |
| `backend/tests/test_game_process.py` | 进程探活缓存、退出后重新应用、pending 标记 |
| `backend/tests/test_conflict_categories.py` | 人物 / 武器 / 界面三类资源的判定差异 |
| `backend/tests/test_api_contract.py` | 72 条路由快照 + 各域端点状态码/形状 + `/api/status` 的 `official_baseline` 三档 |
| `backend/tests/test_perf_budget.py` | 性能预算（`-m perf`） |
| `backend/tests/support/vpkbuild.py` | 最小 VPK 写入器（合成测试数据用） |
| `frontend/tests/` | 混搭语义、色卡约束、MIME 嗅探、动图偏好、窗口尺寸规则（`windowBounds`） |

**测试不碰真实用户数据**：`backend/tests/conftest.py` 在任何后端模块被 import 之前把
`HOME`/`USERPROFILE` 指到临时目录，并逐用例清空 `data_store` 缓存、重建 addons 目录。
`data_store` 的 `_DATA_FILE` 是 import 时算出来的常量，所以这个顺序不能改。

## 性能预算（硬门禁）

| 指标 | 预算 |
|---|---|
| 120 Mod 冷扫描 | ≤ 4000ms |
| 缓存重扫（内容未变） | ≤ 200ms 且 < 冷扫描 / 5 |
| 扫描峰值内存分配 | ≤ 200MB |
| 30 → 120 Mod 耗时放大 | < 12 倍（线性度） |
| 冲突检测 300 Mod × 150 路径 | ≤ 3000ms |
| `/api/mods` 每个 Mod 的 JSON | ≤ 3KB |
| `/api/status`（120 Mod + 真 pak01，含 `official_baseline`） | ≤ 150ms |

阈值比开发机实测宽 5~10 倍，目的是拦「数量级回退」（少一层缓存、O(n) 写成 O(n²)），
不是比机器快慢。要调整阈值，请在 PR 里说明是「机器更慢」还是「行为变了」。

## 用真实库做性能回归（10GB 测试库）

合成 VPK 只覆盖「元数据规模」，真实包里的条目分布、封面、编码千奇百怪。要验证
扫描/冲突链路的改动，用一份按压力面分类的真实库更可信：

```bash
# 1) 出计划（不下载）：按档位分配体积，看各档是否合理
python scripts/fetch_test_corpus.py plan --outdir D:\Sample --budget-gb 10

# 2) 下载（断点续传；40 线程实测 ~10MB/s，8 线程只有 ~1.2MB/s）
python scripts/fetch_test_corpus.py download --outdir D:\Sample --threads 40

# 3) 基线（隔离 HOME，不碰真实 data.json）
python scripts/fetch_test_corpus.py scan --outdir D:\Sample
```

四个档位对应四种压力，不要混在一起看：

| 档位 | 特征 | 压的是什么 |
|---|---|---|
| `A_conflict` | 4~120MB 皮肤/武器，100+ 个 | 包数量、冲突配对、列表渲染 |
| `B_heavy` | 单包 ≥300MB | 磁盘 IO、封面提取、缓存体积 |
| `C_dense` | 材质/音效合集，条目多 | VPK 索引缓存、冲突倒排内存 |
| `D_campaign` | 战役地图，体积大但按需加载 | `is_campaign` 排除、内存统计不被污染 |

改动前后的对比口径：同一台机器、同一份库，跑 `scan` 三次取中位数，
比较「冷扫描 / 缓存重扫 / 峰值分配 / 冲突数 / JSON 体积」五项。
冲突数变化说明判定逻辑变了，不算性能回归，但要单独确认是不是有意的。

## 改路由时必看

`backend/tests/routes_snapshot.json` 是路由表快照。拆分 / 重命名 / 新增路由后：

```bash
cd backend
python -c "import json,sys; sys.path.insert(0,'.'); import main; r=sorted(f'{m} {x.path}' for x in main.app.routes if (ms:=getattr(x,'methods',None)) for m in ms if m not in ('HEAD','OPTIONS')); json.dump(r, open('tests/routes_snapshot.json','w',encoding='utf-8'), ensure_ascii=False, indent=1); print(len(r))"
```

确认改动是**有意的**再更新快照 —— 快照变了但你说不出为什么要多/少一条路由，多半是漏了。

## 后端结构（2026-11 起）

```
backend/
  main.py            装配 app + lifespan + uvicorn 入口（172 行）
  app_state.py       进程级单例：scanner、APP_VERSION、Steam 登录态、懒加载服务访问器
  routers/           按域拆的 HTTP 边界：system / mods / packs / settings /
                     game / auth / workshop / download / media
  services/          业务逻辑：mod_scanner / data_store / conflict_engine /
                     tagger / workshop_* / game_process / media_types / steam_paths
  tests/             pytest
```

约定：router 里只做参数解析、状态码与响应形状；业务逻辑进 `services/`。
router 引用全局扫描器一律写 `app_state.scanner`（不要 `from app_state import scanner`）——
属性访问才能被测试和验证脚本替换。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `TypeError: Client.__init__() got an unexpected keyword argument 'app'` | httpx ≥0.28，按 `requirements-dev.txt` 降到 0.27.x |
| vitest 报 `Unhandled Error: EPERM ... ssr\<hash>` 且退出码 1（个别用例文件被跳过） | 系统临时目录不可写（受限环境）。把 `TEMP`/`TMP` 指到项目内目录再跑：`set TEMP=%CD%\node_modules\.vite-tmp`；如果已经这样还报，删掉该目录重建（残留的旧缓存目录可能带着别的权限） |
| 测试跑完用户数据变了 | 说明 conftest 的 HOME 隔离没生效（有人在 import 后端模块之前没走 conftest），检查有没有在 `conftest.py` 之前 import 项目模块 |
| `pytest` 报 `ModuleNotFoundError: services` | 在仓库根目录跑（`pytest.ini` 里有 `pythonpath = backend`），或用 `python -m pytest` |
| 性能用例在 CI 上偶发超时 | 先看 `--durations=10`；确认不是「第一次跑要编译 .pyc」造成的，重跑一次仍红再改预算 |

## CI

`.github/workflows/ci.yml`，两个 job（均 `windows-latest`）：

1. **backend**：ruff（只留 F821/F811/E9 这类「会直接崩」的规则）→ `pytest -m "not perf"` → `pytest -m perf`
2. **frontend**：`npm ci --ignore-scripts` → 两套 tsc → `vitest run` → `vite build`

用 Windows runner 是因为代码里有 `tasklist`、`winreg`、ANSI 代码页等平台分支；
`--ignore-scripts` 跳过 Electron 二进制下载（类型检查 / 单测 / 构建渲染层都用不到）。
