# 省流看

省流看是一个本地运行的 Bilibili 视频分析工具。输入公开 BV 号或视频地址后，可以读取视频信息、选择分析方式和模型，并查看任务进度、分析报告与历史记录。

当前仓库采用 monorepo 结构。Web 前端、后端 API 和后续桌面端都放在 `apps/` 下，共用代码后续放在 `packages/`。

## 目录结构

```text
bilibili-video-analysis/
├─ apps/
│  ├─ web/          Vue Web 前端
│  ├─ api/          NestJS 本地后端
│  └─ desktop/      Electron 桌面端预留目录
├─ packages/
│  └─ shared/       共享类型和工具预留目录
├─ docs/
│  └─ 
├─ package.json
├─ pnpm-workspace.yaml
└─ README.md
```

## 本地启动

进入项目目录：

```powershell
cd D:\Desktop\项目\bilibili-vedio-analyze\bilibili-video-analysis
```

安装依赖：

```powershell
pnpm install
```

同时启动 Web 前端和后端 API：

```powershell
pnpm dev
```

分别启动：

```powershell
pnpm dev:api
pnpm dev:web
```

默认地址：

```text
Web: http://localhost:5173
API: http://127.0.0.1:3000/api
```

## 构建

构建全部应用：

```powershell
pnpm build
```

单独构建：

```powershell
pnpm build:api
pnpm build:web
```

预览 Web 构建结果：

```powershell
pnpm preview
```

## 后端接口

Web 前端使用相对路径访问 `/api`，开发环境由 Vite 代理到 `http://127.0.0.1:3000`。

当前后端需要提供：

| 方法 | 地址 | 用途 |
|---|---|---|
| `POST` | `/api/model-configs/test` | 测试并保存模型配置 |
| `GET` | `/api/model-configs` | 读取模型配置 |
| `DELETE` | `/api/model-configs/:id` | 删除模型配置 |
| `POST` | `/api/analysis/jobs` | 创建视频分析任务 |
| `GET` | `/api/analysis/jobs/:id` | 获取任务状态和处理进度 |
| `POST` | `/api/analysis/jobs/:id/cancel` | 取消分析任务 |
| `GET` | `/api/analysis/reports/:id` | 获取结构化分析报告 |
| `POST` | `/api/analysis/reports/:id/questions` | 基于当前报告继续追问 |

接口范围见 [后端 PRD](docs/backend-prd.md)。前端字段定义见 [apps/web/src/types/domain.ts](apps/web/src/types/domain.ts)，后端当前也保留了一份对应类型在 [apps/api/src/common/domain.ts](apps/api/src/common/domain.ts)。后续可以把公共类型迁到 `packages/shared`。

## 功能使用

### 1. 配置模型

进入左侧的“模型管理”，点击“添加配置”。

需要填写：

- 配置名称
- 模型厂商
- API Base URL
- API Key
- 模型名称
- 模型能力
- 请求超时时间
- 最大并发数

模型能力分为文本总结、ASR 识别、图片理解和视频理解。不同分析模式需要不同的模型组合。

保存前会调用本地后端测试连接。API Key 只发送给本地后端，前端不会把密钥写入 `localStorage`。

### 2. 读取视频

进入“新建分析”，输入 BV 号或 Bilibili 视频地址：

```text
BV1xxxxxxxxx
```

```text
https://www.bilibili.com/video/BV1xxxxxxxxx
```

点击“读取视频”后，页面会显示标题、封面、UP 主、发布时间、视频时长、简介和分 P 信息。

目前只支持公开且无需登录的视频，不接收 Bilibili Cookie，也不处理会员、付费、私密或地区受限内容。

### 3. 设置分析方式

可选择两种分析模式：

- **字幕优先 + ASR**：优先使用公开字幕，没有字幕时由 ASR 补全。
- **整段视频多模态**：综合处理语音、字幕和画面。

还可以设置：

- 快速、标准或深度分析
- 是否生成关键截图
- 是否保留时间戳
- 输出语言
- 最大截图数量
- 各项能力使用的模型
- 需要处理的分 P

页面不会在分析失败后自动切换模式，避免产生没有确认过的模型费用。

### 4. 提交与取消任务

点击“确认并开始分析”后，由本地后端创建任务。“进行中”页面展示当前阶段、整体进度、状态说明、失败原因和取消入口。

取消操作是否同时清理视频、音频和截图缓存，由后端实现负责。

### 5. 查看报告

任务完成后，可以从任务页或历史记录打开报告。报告页面支持：

- 一句话结论
- 内容概览
- 章节时间线
- 核心观点
- 事实和案例
- 作者结论或立场
- 可信度提示
- 时间戳跳转
- 基于报告继续追问
- 导出 TXT
- 通过浏览器打印功能导出 PDF

## 本地数据

前端使用浏览器 `localStorage` 保存非敏感界面数据。API Key 由本地后端处理，不写入浏览器本地存储。

后端运行数据默认保存在 `apps/api/data/`，该目录不会提交到仓库。

