# Minecraft 材料表工具集 — 完整指南

## 目录

1. [项目概述](#1-项目概述)
2. [功能特性](#2-功能特性)
3. [项目结构](#3-项目结构)
4. [技术架构](#4-技术架构)
5. [使用指南](#5-使用指南)
   - [Tab 1：投影转换](#51-tab-1投影转换)
   - [Tab 2：材料分配](#52-tab-2材料分配)
   - [桥接功能：发送到材料分配](#53-桥接功能发送到材料分配)
6. [文件格式说明](#6-文件格式说明)
7. [翻译映射表维护](#7-翻译映射表维护)
8. [Python 参考实现](#8-python-参考实现)
9. [旧版独立工具](#9-旧版独立工具)
10. [部署说明](#10-部署说明)
11. [常见问题](#11-常见问题)

---

## 1. 项目概述

Minecraft 材料表工具集是一个纯前端 Web 应用，专为中大型 Minecraft 建筑工程设计。它解决了以下核心痛点：

- **从投影文件提取材料清单**：直接解析 Litematica 的 `.litematic` 文件，自动统计所有方块数量
- **英文方块名自动翻译**：内置 1000+ 条 Minecraft 方块的中英文翻译映射表，覆盖至 **1.21.5 (Spring to Life / 万物逢春)**
- **材料智能分组**：自动将同类型材料（如不同颜色的混凝土、不同木种的楼梯台阶）归入同一材料组
- **收集进度跟踪**：可标记每种材料是否已收集完毕，实时显示完成百分比
- **导出功能**：支持导出 CSV 和 XLSX 格式，便于分发和打印

项目面向**浏览器直接运行**，无需安装任何后端服务或构建工具，双击打开 HTML 文件即可使用。

---

## 2. 功能特性

### Tab 1 — 投影转换（Litematic → 材料清单）

| 功能 | 说明 |
|------|------|
| **拖拽上传** | 支持拖拽或点击选择 `.litematic` 文件 |
| **NBT 解析** | 完整的 NBT 二进制格式解析器（纯 JavaScript 实现） |
| **GZip 解压** | 使用浏览器原生 `DecompressionStream` API |
| **方块解码** | 按位解码 BlockStates 长数组，精确还原每个方块 |
| **文件信息展示** | 显示版本、尺寸、方块总数、实体数等元数据 |
| **翻译缺失警告** | 自动检测未翻译的英文方块名，可下载日志 |
| **CSV 导出** | 导出包含序号/英文名/中文名/总数/组数/盒数的 CSV |
| **桥接到分配** | 一键将转换结果发送到材料分配标签页 |

### Tab 2 — 材料分配（进度跟踪 + 智能分组）

| 功能 | 说明 |
|------|------|
| **CSV 导入** | 支持新旧两种 CSV 格式的自动识别 |
| **智能分组** | 基于中文名称的后缀/前缀匹配，将同类材料归组 |
| **状态标记** | 点击圆形按钮标记材料已收集/未收集 |
| **搜索** | 按名称、组号、数量等关键字实时过滤 |
| **筛选** | 按已分配/未分配状态筛选 |
| **进度条** | 可视化显示收集完成百分比 |
| **全部标记** | 一键标记全部完成或全部取消 |
| **重置** | 清空所有完成状态 |
| **XLSX 导出** | 导出含材料组和收集者列的 Excel 文件 |

---

## 3. 项目结构

```
材料表工具/
├── index.html                          ★ 主入口文件（合并版，推荐使用）
├── 爱弥斯.jpg                          网站图标
├── parse_litematic.py                  Python 版 NBT 解析器（参考/验证用）
│
├── assets/                             ★ 合并版核心资源
│   ├── script.js                      合并的 JavaScript 逻辑
│   │   ├── Module A：投影转换（原 parser.js）
│   │   └── Module B：材料分配（原 csv-assign-tool/script.js）
│   └── style.css                      合并的样式表
│
├── block-csv-tool/                    旧版独立 — 投影转换工具
│   ├── index.html                     独立页面
│   ├── parser.js                      NBT 解析器（功能已合并到 assets/script.js）
│   ├── style.css                      独立样式
│   ├── minecraft-translations.js      ★ 翻译映射表（两个工具共享）
│   └── _verify_translations.py        翻译表完整性验证脚本
│
└── csv-assign-tool/                   旧版独立 — 材料分配工具
    ├── index.html                     独立页面
    ├── script.js                      分配逻辑（功能已合并到 assets/script.js）
    └── style.css                      独立样式
```

> **推荐使用根目录的 `index.html`（合并版）**。旧版独立工具保留用于参考，但不再维护。
> 合并版通过标签页（Tab）在投影转换和材料分配之间切换，并提供一键桥接功能。

---

## 4. 技术架构

### 纯前端 / 零依赖

- **无框架**：原生 HTML + CSS + JavaScript
- **无构建工具**：所有代码直接运行在浏览器中
- **零安装**：双击 `index.html` 即可使用

### 外部 CDN 依赖

| 库 | 用途 | 加载方式 |
|----|------|----------|
| [SheetJS (xlsx)](https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js) | XLSX 文件导出 | CDN `<script>` 标签 |

### 核心技术点

#### 1. NBT 二进制解析

Litematica 文件是一个 GZip 压缩的 NBT（Named Binary Tag）文件。解析流程：

```
.litematic 文件
  → GZip 解压（DecompressionStream API）
  → NBT 格式解析（自定义 NBTReader 类）
    • TAG_Compound (0x0A)：根容器
    • TAG_String (0x08)：UTF-8 字符串
    • TAG_Int (0x03)：32 位整数
    • TAG_Long (0x04)：64 位长整数
    • TAG_List (0x09)：列表
    • TAG_Byte_Array (0x07)：字节数组
    • TAG_Int_Array (0x0B)：整数数组
    • TAG_Long_Array (0x0C)：长整数数组
  → 提取 Regions → BlockStatePalette + BlockStates
```

#### 2. 方块状态解码

方块数据存储为位打包的长整数数组。对于有 N 种方块类型的调色板，每个方块使用 `ceil(log2(N))` 位存储。

```
bitsPerBlock = max(2, ceil(log2(paletteSize)))
mask = (1 << bitsPerBlock) - 1

for each block index i:
    startBit = i × bitsPerBlock
    startLong = startBit / 64
    bitOffset = startBit % 64
    if fits in one long:
        idx = (longs[startLong] >> bitOffset) & mask
    else:
        idx = (part1 from longs[startLong]) | (part2 from longs[startLong+1] << bitsFromFirst)
```

#### 3. 材料智能分组

分组算法基于两阶段中文名称分析：

**阶段 1：后缀匹配（识别材料类别）**
将材料按后缀归类，例如 "橡木楼梯" 和 "石砖楼梯" 都识别为 "楼梯"。

预定义了 100+ 个常见后缀：
```
'台阶', '楼梯', '墙', '门', '栅栏', '栅栏门', '活板门',
'木板', '原木', '木头', '树叶', '玻璃', '玻璃板',
'混凝土', '混凝土粉末', '石砖', '砖块', ...
```

**阶段 2：前缀剥离（提取材质变种）**
在同类别内剥离颜色/木种等前缀，例如 "白色混凝土" → 剥离 "白色" → "混凝土"。

预定义了 100+ 个常见前缀：
```
'白色', '橙色', '品红色', ...（16 种颜色）
'橡木', '云杉', '白桦', ...（木质前缀）
'斑驳的', '锈蚀的', '氧化的', ...（铜氧化前缀）
'去皮', '錾制', '磨制', ...（加工前缀）
```

#### 4. 翻译映射

`minecraft-translations.js` 维护了一个 1000+ 条目的英文到中文翻译映射表，涵盖：

- 所有染色玻璃/玻璃板（16 × 2 = 32 条）
- 所有混凝土/混凝土粉末（16 × 2 = 32 条）
- 所有羊毛/地毯/陶瓦/带釉陶瓦（16 × 4 = 64 条）
- 所有床/旗帜/蜡烛/潜影盒（16 × 4 = 64 条）
- 所有木种（12 种）的门/活板门/栅栏/栅栏门/按钮/压力板/告示牌/悬挂告示牌
- 石头/深板岩/凝灰岩/花岗岩/闪长岩/安山岩及其变种
- 铜全系列（基础+氧化+涂蜡所有变种）
- 下界/末地/海洋/红石/装饰方块

---

## 5. 使用指南

### 5.1 Tab 1：投影转换

#### 步骤 1：打开工具
在浏览器中打开 `index.html`，默认显示"投影转换"标签页。

#### 步骤 2：加载投影文件
- **方式 A**：点击上传区域，选择 `.litematic` 文件
- **方式 B**：从文件管理器拖拽 `.litematic` 文件到上传区域

#### 步骤 3：查看解析结果
文件加载后，页面依次显示：
1. **进度条**：GZip 解压 → NBT 解析 → 方块解码 → 统计 → 渲染
2. **文件信息**：版本号、区域名称、尺寸、方块总数、实体数等
3. **翻译警告**（如有）：列出未找到中文翻译的英文名称，可下载日志文件
4. **材料清单表格**：

| # | 英文名称 | 中文名称 | 总数 | 组数 | 盒数 |
|---|----------|----------|------|------|------|
| 1 | white_concrete | 白色混凝土 | 1,637 | 26 | 1 |
| 2 | stone_bricks | 石砖 | 892 | 14 | 1 |

- **总数**：方块的绝对数量
- **组数** = `ceil(总数 / 64)`，Minecraft 中一组为 64 个
- **盒数** = `ceil(组数 / 27)`，一个潜影盒可装 27 组

#### 步骤 4：导出或发送
- **导出 CSV**：下载为 `.csv` 文件，可导入材料分配工具
- **发送到材料分配**：一键将数据桥接到 Tab 2，无需手动导出/导入
- **清除**：清空当前解析结果

---

### 5.2 Tab 2：材料分配

#### 方式 A：从投影转换桥接
在 Tab 1 中点击「📋 发送到材料分配」，自动跳转到 Tab 2 并加载数据。

#### 方式 B：手动导入 CSV
1. 切换到「材料分配」标签页
2. 点击上传区域或拖拽 `.csv` 文件（支持从 Tab 1 导出的 CSV）
3. 工具自动解析并显示材料列表

#### 界面操作

**材料表格**：

| 状态 | # | 中文名称 | 总数 | 组数 | 盒数 | 材料组 |
|------|---|----------|------|------|------|--------|
| ✓ | 1 | 白色混凝土 | 1,637 | 26 | 1 | 1 |
| ○ | 1 | 橙色混凝土 | 432 | 7 | 1 | 1 |

- 点击圆形按钮切换完成/未完成状态
- 同一材料组的材料用分隔行聚在一起

**工具栏**：
- 🔍 **搜索**：输入关键字实时过滤（支持中文名、组号、数量等）
- 🏷️ **筛选**：按"未分配"或"已分配"状态过滤
- 📊 **统计**：显示已完成数 / 总数 · 材料组数
- 📥 **导出 XLSX**：导出为 Excel 格式，包含材料组编号和收集者列
- ✓ **全部标记完成**：一键标记所有材料为已完成（再次点击全部取消）
- 🔄 **重置全部**：清空所有完成状态

**进度条**：
显示收集进度百分比和已完成/总材料种类数。

---

### 5.3 桥接功能：发送到材料分配

这是合并版的核心便利功能：

```
Tab 1 转换完成
    ↓ 点击「📋 发送到材料分配」
Tab 2 接收数据
    • 自动翻译英文名 → 中文名
    • 去重合并同名材料
    • 重新计算组数/盒数
    • 执行智能分组
    • 渲染材料表格
    • 自动跳转到材料分配标签页
```

无需手动导出 CSV 再导入，一键完成整个流程。

---

## 6. 文件格式说明

### 输入格式：`.litematic` 文件

Litematica 是 Minecraft 的建筑投影模组，其文件格式为：

```
┌──────────────────────────────────────┐
│  GZip 压缩层                          │
│  ┌──────────────────────────────────┐ │
│  │  NBT 格式数据                     │ │
│  │  ├── MinecraftDataVersion (Int)  │ │
│  │  ├── Version (Int)               │ │
│  │  ├── Metadata (Compound)         │ │
│  │  │   ├── Name (String)           │ │
│  │  │   ├── Author (String)         │ │
│  │  │   ├── Description (String)    │ │
│  │  │   ├── TimeCreated (Long)      │ │
│  │  │   ├── TimeModified (Long)     │ │
│  │  │   ├── RegionCount (Int)       │ │
│  │  │   ├── TotalBlocks (Int)       │ │
│  │  │   └── EnclosingSize (Compound)│ │
│  │  └── Regions (Compound)          │ │
│  │      └── <region_name>           │ │
│  │          ├── Size (Compound)     │ │
│  │          │   ├── x (Int)         │ │
│  │          │   ├── y (Int)         │ │
│  │          │   └── z (Int)         │ │
│  │          ├── Position (Compound) │ │
│  │          ├── BlockStatePalette   │ │
│  │          │   └── [N]             │ │
│  │          │     ├── Name (String) │ │
│  │          │     └── Properties    │ │
│  │          ├── BlockStates         │ │
│  │          │   └── [M] (Long[])    │ │
│  │          ├── Entities (List)     │ │
│  │          └── TileEntities (List) │ │
│  └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### 导出格式：CSV

```csv
序号,英文名称,中文名称,总数,组数,盒数
1,white_concrete,白色混凝土,1637,26,1
2,stone_bricks,石砖,892,14,1
...
,,合计 256 种方块,6733,319,256

文件,100w收集.litematic
尺寸,100×80×64
方块总数,512000
非空气方块,6733
方块种类,256
```

- 编码：UTF-8 with BOM（兼容 Excel 中文显示）
- CSV 末尾附有元数据（文件名、尺寸等），导入分配工具时会自动解析
- 支持新旧两种格式的自动识别（带/不带英文名称列）

### 导出格式：XLSX

| 序号 | 中文名称 | 总数 | 组数 | 盒数 | 材料组 | 材料收集者 |
|------|----------|------|------|------|--------|------------|
| 1 | 白色混凝土 | 1637 | 26 | 1 | 材料组1 | |
| 1 | 橙色混凝土 | 432 | 7 | 1 | 材料组1 | |
| 2 | 石砖 | 892 | 14 | 1 | 材料组2 | |

- 使用 SheetJS 库生成
- 同材料组之间插入空行便于阅读
- "材料收集者"列为空列，便于手动填写分工信息

---

## 7. 翻译映射表维护

### 位置

`block-csv-tool/minecraft-translations.js`

### 格式

```javascript
const MINECRAFT_BLOCK_TRANSLATIONS = {
    'english_block_id': '中文名称',
    'white_concrete': '白色混凝土',
    // ...
};
```

### 添加新翻译

1. 在 `MINECRAFT_BLOCK_TRANSLATIONS` 对象中添加新条目
2. 键名必须与 `.litematic` 文件中 `BlockStatePalette[].Name` 去掉 `minecraft:` 前缀后完全一致
3. 按照注释分类放置（如 `// ===== 铜 (基础) =====`）

### 验证翻译完整性

运行验证脚本检查是否有遗漏或重复的条目：

```bash
cd 材料表工具
python block-csv-tool/_verify_translations.py
```

输出示例：
```
Total entries: 1234
Duplicate keys: None
  glass: 42 entries
  wool: 17 entries
  concrete: 32 entries
  stained_glass: 16/16 complete
  ...
```

### 翻译缺失处理

当解析到翻译表中不存在的方块时：
1. 页面显示黄色警告框，列出所有未翻译的英文名称
2. 在浏览器控制台输出 `[翻译缺失]` 日志
3. 可点击「📥 下载翻译缺失日志」导出完整列表
4. 表格中该方块的中文名称留空

---

## 8. Python 参考实现

`parse_litematic.py` 是一个独立的 Python 参考实现，用于：

- **理解 NBT 格式**：代码清晰展示了每种 TAG 类型的解析逻辑
- **验证 JavaScript 实现**：可对比两种实现的结果
- **调试**：输出详细的中间数据（区域名称、方块调色板、每种方块数量）

### 使用方法

```bash
python parse_litematic.py path/to/file.litematic
```

### 输出内容

```
=== Root keys ===
  MinecraftDataVersion: Int = 3953
  Version: Int = 7
  Metadata: dict (3 keys)
  Regions: dict (1 keys)

Regions: 1 region(s)

--- Region: 主区域 ---
  BlockStates: palette has 256 entries
    [0] Name=minecraft:air Properties={}
    [1] Name=minecraft:stone Properties={}
    ...
  BlockStates raw data: 8000 longs
  Region size: 100x80x64 = 512000 blocks
  Decoded 512000 block indices

  === Block counts (256 unique types) ===
    1637  white_concrete
     892  stone_bricks
     ...
```

---

## 9. 旧版独立工具

`block-csv-tool/` 和 `csv-assign-tool/` 目录包含早期独立版本。它们的功能已完全合并到根目录的 `index.html`（合并版）中。

| 工具 | 旧版路径 | 合并版位置 |
|------|----------|------------|
| 投影转换 | `block-csv-tool/index.html` | 根 `index.html` Tab 1 |
| 材料分配 | `csv-assign-tool/index.html` | 根 `index.html` Tab 2 |

旧版独立工具的优势是完全自包含，可单独部署。但合并版提供了标签页切换和桥接功能，推荐使用合并版。

---

## 10. 部署说明

### 本地使用

1. 下载整个项目文件夹
2. 双击 `index.html` 在浏览器中打开
3. 确保所有文件保持原有的目录结构

### Web 服务器部署

将整个文件夹放到任意 Web 服务器即可：

```bash
# 使用 Python 简易服务器
cd 材料表工具
python -m http.server 8080

# 使用 Node.js
npx serve .

# 使用 Nginx
cp -r 材料表工具 /var/www/html/
```

### 离线使用

项目依赖 SheetJS CDN。如需完全离线使用：

1. 下载 [xlsx.full.min.js](https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js)
2. 放到项目根目录
3. 修改 `index.html` 中的 CDN 引用为本地路径：

```html
<!-- 将 -->
<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>
<!-- 改为 -->
<script src="xlsx.full.min.js"></script>
```

> 注：即使不加载 xlsx 库，Tab 1 的所有功能（包括 CSV 导出）仍可正常使用。只有 Tab 2 的 XLSX 导出需要此库。

### 浏览器兼容性

| 功能 | 依赖 API | 最低版本 |
|------|----------|----------|
| GZip 解压 | `DecompressionStream` | Chrome 80+, Edge 80+, Firefox 100+, Safari 16.4+ |
| BigInt | `BigInt` | Chrome 67+, Edge 79+, Firefox 68+, Safari 14+ |
| 文件拖拽 | Drag and Drop API | 所有现代浏览器 |
| 文件读取 | FileReader / File API | 所有现代浏览器 |

---

## 11. 常见问题

### Q: 为什么有些方块没有中文名称？

A: 翻译映射表可能尚未收录该方块。请查看页面上的黄色警告框获取未翻译列表，并可下载日志文件。欢迎向翻译表提交新增条目。

### Q: 材料分组不准确怎么办？

A: 分组算法基于中文名称的后缀/前缀匹配。如果分组不理想，可以：
1. 查看 `assets/script.js` 中的 `MATERIAL_SUFFIXES` 和 `MATERIAL_PREFIXES` 数组
2. 按需要在对应数组中添加新的后缀或前缀
3. 注意：长后缀优先匹配，所以添加时应考虑长度顺序

### Q: 如何处理包含实体的投影文件？

A: 当前版本仅统计方块，不处理实体（如物品展示框、矿车等）。实体信息在文件信息面板中显示，但不计入材料清单。

### Q: 支持哪些 .litematic 文件版本？

A: 支持所有使用标准 NBT 格式的 Litematica 投影文件。目前测试了 Minecraft 1.16 到 1.21.5 版本生成的文件。如果遇到无法解析的文件，可以使用 `parse_litematic.py` 调试。

### Q: 如何在手机/平板上使用？

A: 合并版已针对移动端做了完整的响应式适配：
- 标签导航：触摸友好的大按钮
- 文件选择：iOS Safari 兼容的 `<label>` 方式
- 表格：水平滚动支持
- 小屏幕：自动隐藏次要列（如英文名称列、序号列）
- 按钮：充足的触摸区域（最小 36px 高度）

### Q: 导出的 CSV 在 Excel 中打开乱码？

A: 工具导出的 CSV 使用 UTF-8 with BOM 编码。如果仍然乱码，使用 Excel 的「数据 → 从文本/CSV 导入」功能，选择 UTF-8 编码导入。

---

## 许可

&copy; 2026 材料表工具集 — 适用于 Minecraft 社区的建筑材料管理。

项目地址：[GitHub](https://github.com/xiaofengxfc/Minecraft-Material-Allocation-Tool)