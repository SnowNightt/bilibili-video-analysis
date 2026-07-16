# 服务层接口契约

前端不包含演示业务数据。视频信息来自 Bilibili 公共元数据接口，其余能力由本地后端提供。

## 模型配置

- `GET /api/model-configs`
- 响应：`ModelConfig[]`
- `POST /api/model-configs/test`
- 请求体：`ModelConfigDraft`
- 响应：`{ "ok": true, "config": ModelConfig }`
- `DELETE /api/model-configs/:id`
- 响应：`{ "ok": true }`
- API Key 只在本次请求中发送给本地后端，前端存储仅保存 `apiKeyConfigured` 状态。

## 分析任务

- `POST /api/analysis/jobs`：创建任务，请求体包含 `video` 和 `options`
- `GET /api/analysis/jobs`：读取后端持久化的全部任务
- `GET /api/analysis/jobs/:id`：读取任务最新状态
- `POST /api/analysis/jobs/:id/cancel`：取消任务
- `DELETE /api/analysis/jobs/:id`：删除任务、报告和持久截图
- 响应结构：`AnalysisJob`

## 报告与追问

- `GET /api/analysis/reports/:id`：读取 `AnalysisReport`
- `POST /api/analysis/reports/:id/questions`：提交 `{ "question": string }`
- 追问响应结构：`ConversationMessage`

具体领域结构定义在 `src/types/domain.ts`。
