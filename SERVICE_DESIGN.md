# OmniGen2 服务端架构设计文档

## 📋 项目概述

基于现有 ComfyUI 和 comfyui-web 的智能中间层，提供用户系统、配额管理、多后端负载均衡、API 网关等功能。

**技术栈：** Node.js + Express + PostgreSQL + Redis + BullMQ

---

## 🏗️ 系统架构

```
┌─────────────┐
│  前端客户端  │ ← Web/Vue/移动端
└──────┬──────┘
       │ HTTPS / API
       ▼
┌─────────────────────┐
│  新服务（API网关）   │ ← 用户系统、配额、队列、负载均衡
│  - 鉴权中间件        │ ← 数据库：PostgreSQL（用户、配额、账单）
│  - 任务队列（Bull）  │ ← 缓存：Redis（配额计数、限流）
│  - 负载均衡器       │
│  - WebSocket 服务   │
└──────┬──────────────┘
       │ 转发任务
       ▼
┌─────────────────────┐
│   ComfyUI 集群      │ ← 多个后端节点
│  - Node 1 (主)      │   自动健康检查
│  - Node 2 (备)      │   故障转移
└─────────────────────┘
```

---

## 📦 核心功能模块

### 1. 用户系统
- 注册/登录（邮箱+密码）
- API Key 管理（主key+子key）
- 个人中心（配额、使用记录、套餐）

### 2. 配额与计费
- 每日免费配额
- 付费套餐（点数制）
- 不同分辨率消耗不同点数
- 使用记录与账单

### 3. 任务调度
- 优先级队列（VIP/普通）
- 并发控制（GPU显存限制）
- 超时自动取消
- 批量任务支持

### 4. 多后端管理
- 后端节点注册与发现
- 健康检查（每30秒）
- 负载均衡（最少任务优先）
- 故障自动转移

### 5. 实时通知
- WebSocket 推送进度
- 任务完成/失败通知
- 队列位置更新

### 6. 管理后台
- 用户管理
- 套餐管理
- 财务统计
- 系统监控
- 公告推送

---

## 🔐 安全设计

- API Key 鉴权（Header: `X-API-Key`）
- 请求限流（每用户 10次/分钟）
- 配额校验中间件
- 敏感信息日志脱敏
- 密码 bcrypt 加密
- SQL 注入防护（参数化查询）

---

## 💾 数据库设计（PostgreSQL）

### users
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  api_key VARCHAR(64) UNIQUE NOT NULL, -- 主key
  is_admin BOOLEAN DEFAULT FALSE,
  banned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### plans
```sql
CREATE TABLE plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL, -- free/basic/pro/enterprise
  price_monthly DECIMAL(10,2) DEFAULT 0,
  quota_monthly INT NOT NULL, -- 每月总点数
  features JSONB, -- 存储特性列表
  is_active BOOLEAN DEFAULT TRUE
);
```

### user_plans
```sql
CREATE TABLE user_plans (
  user_id INT REFERENCES users(id),
  plan_id INT REFERENCES plans(id),
  starts_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  auto_renew BOOLEAN DEFAULT FALSE,
  PRIMARY KEY (user_id)
);
```

### daily_quotas
```sql
CREATE TABLE daily_quotas (
  user_id INT REFERENCES users(id),
  date DATE NOT NULL, -- 日期（Asia/Shanghai）
  used_quota INT DEFAULT 0,
  remaining_quota INT NOT NULL,
  PRIMARY KEY (user_id, date)
);
```

### usage_records
```sql
CREATE TABLE usage_records (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  prompt_id VARCHAR(255) NOT NULL,
  resolution VARCHAR(50) NOT NULL,
  steps INT NOT NULL,
  cost INT NOT NULL, -- 消耗的点数
  status VARCHAR(50), -- completed/error/timeout
  image_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### api_keys
```sql
CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  key_name VARCHAR(100),
  key_prefix VARCHAR(12) UNIQUE NOT NULL, -- 前12位用于识别
  key_hash VARCHAR(255) NOT NULL, -- 完整key的hash用于验证
  is_active BOOLEAN DEFAULT TRUE,
  daily_limit INT, -- 单独限制，null表示无限制
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### payments
```sql
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  plan_id INT REFERENCES plans(id),
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50), -- alipay/wechatpay/stripe
  payment_id VARCHAR(255), -- 第三方支付单号
  status VARCHAR(50), -- pending/success/failed/refunded
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 🔌 API 设计

### 认证方式
所有接口需在 Header 中包含 `X-API-Key`：
```http
X-API-Key: sk-xxxxxxxxxxxxxxxx
```

### 生成接口
```http
POST /api/v1/generate
Content-Type: application/json

{
  "prompt": "美丽的风景",
  "negative": "模糊,低质量",
  "resolution": "1024x1024",
  "steps": 20,
  "cfg": 5,
  "seed": 12345  // 可选
}

成功响应：
{
  "success": true,
  "prompt_id": "uuid",
  "estimated_duration": 60,
  "remaining_quota_today": 450
}

失败响应：
{
  "success": false,
  "error": "配额不足"
}
```

### 查询状态
```http
GET /api/v1/status?prompt_id=uuid

响应：
{
  "success": true,
  "status": "pending/completed/error",
  "progress": 75.5,
  "estimated_duration": 60,
  "images": [
    {
      "filename": "xxx.png",
      "url": "/api/v1/image/xxx.png",
      "width": 1024,
      "height": 1024
    }
  ],
  "error": "错误信息（如有）"
}
```

### 获取用户信息
```http
GET /api/v1/user/info

响应：
{
  "user_id": 123,
  "plan": "pro",
  "plan_expires_at": "2026-04-01T00:00:00Z",
  "quota_today": 100,
  "quota_used": 25,
  "quota_remaining": 75,
  "quota_monthly": 2000,
  "quota_monthly_used": 300
}
```

### WebSocket 连接
```js
// 连接地址
const ws = new WebSocket('wss://your-server/ws?api_key=YOUR_KEY')

// 订阅任务进度
ws.send(JSON.stringify({
  type: 'subscribe',
  prompt_id: 'uuid'
}))

// 接收消息
ws.onmessage = (event) => {
  const data = JSON.parse(event.data)
  // { type: 'progress', prompt_id: 'xxx', progress: 50, estimated_remaining: 30 }
  // { type: 'completed', prompt_id: 'xxx', images: [...] }
  // { type: 'error', prompt_id: 'xxx', error: '...' }
}
```

---

## 🎯 点数消耗规则

| 分辨率 | 基础点数 | 说明 |
|--------|---------|------|
| 512×512 | 1 | 基础单位 |
| 768×432 | 1.5 | 按像素面积折算 |
| 1024×576 | 2.5 | |
| 768×1024 | 2.5 | |
| 1024×768 | 2.5 | |
| 1024×1024 | 4 | |
| 1920×1080 | 8 | |

**步骤数调整：**
- 默认 steps=20 时使用基础点数
- steps > 20：`基础点数 × (1 + (steps - 20) / 10 × 0.5)`
- 例如：steps=30，1024×1024 → 4 × 1.5 = 6 点

---

## 📊 管理后台功能

### 仪表盘
- 今日请求数、成功率、平均耗时
- 实时 GPU 负载监控（从 ComfyUI 拉取）
- 队列长度与预估等待时间
- 收入趋势图

### 用户管理
- 搜索用户（邮箱、API Key）
- 查看用户详情（配额使用、历史记录）
- 手动调整配额
- 封禁/解封账号
- 重置用户每日配额

### 套餐管理
- 创建/编辑套餐
- 调整价格和点数
- 启用/停用套餐
- 查看套餐订阅分布

### 财务管理
- 收入统计（日/月/年）
- 支付成功/失败率
- 导出账单数据（CSV）
- 手动创建退款

### 系统日志
- 所有请求日志（可筛选）
- 错误日志高亮
- 导出日志

### 公告管理
- 创建系统公告（首页弹窗）
- 设置生效时间
- 查看已读/未读统计

---

## ⚙️ 配置文件

```yaml
# config.yaml
server:
  port: 3000
  host: 0.0.0.0
  cors_origins: ["http://localhost:10005"]

database:
  host: localhost
  port: 5432
  database: omni_service
  username: postgres
  password: your_password

redis:
  host: localhost
  port: 6379
  password:

queue:
  default_concurrency: 2  # 默认并发数（每GPU）
  default_timeout: 300    # 任务超时（秒）
  poll_interval: 1000     # 状态轮询间隔（毫秒）

backend:
  backends:
    - id: "node1"
      url: "http://43.130.105.192:8188"
      priority: 1
      max_concurrent: 2
    - id: "node2"
      url: "http://backup.example.com:8188"
      priority: 2
      max_concurrent: 1
  health_check_interval: 30000  # 健康检查间隔（毫秒）
  health_check_timeout: 5000

quota:
  free:
    daily_quota: 10
    resolution_multipliers:
      "512x512": 1
      "1024x1024": 2
      "1920x1080": 4
  default: 180  # 预估时间默认值（秒）

websocket:
  enabled: true
  ping_interval: 30000

admin:
  enable_panel: true
  panel_path: "/admin"

payment:
  pingxx_api_key: "your_key"
  alipay_app_id: "your_app_id"
  wechatpay_mch_id: "your_mch_id"
```

---

## 🚀 部署清单

### 前置条件
- Node.js 18+（推荐 20）
- PostgreSQL 14+
- Redis 6+
- Nginx（反向代理）
- SSL 证书（Let's Encrypt）

### 安装步骤
1. 克隆代码到 `/opt/omni-service`
2. `npm install`
3. 创建数据库：`createdb omni_service`
4. 运行迁移：`npx sequelize-cli db:migrate`
5. 复制 `config.yaml.example` 为 `config.yaml` 并修改配置
6. 设置环境变量：
   ```bash
   export NODE_ENV=production
   export CONFIG_PATH=/opt/omni-service/config.yaml
   ```
7. 启动服务：`npm start`
8. 配置 Nginx 反向代理到 `localhost:3000`
9. 配置 Systemd 自动重启

### 监控
- Prometheus 指标端点：`/metrics`
- 日志输出到 stdout（Docker 环境）或 `/var/log/omni-service`
- 错误报警（邮件/钉钉）

---

## 📝 开发规范

### 代码结构
```
src/
├── config/           # 配置加载
├── middleware/       # 中间件（鉴权、配额、限流）
├── models/           # Sequelize 模型定义
├── routes/           # API 路由
│   ├── auth.ts
│   ├── user.ts
│   ├── generate.ts
│   ├── status.ts
│   └── admin.ts
├── services/         # 业务逻辑层
│   ├── user.service.ts
│   ├── quota.service.ts
│   ├── queue.service.ts
│   └── payment.service.ts
├── queue/            # Bull 队列定义
│   ├── generate.queue.ts
│   └── workers/      # 队列消费者
├── backends/         # 多后端管理
│   ├── pool.ts       # 后端池
│   └── health.ts     # 健康检查
├── websocket/        # WebSocket 服务
├── utils/            # 工具函数
└── app.ts            # Express 应用入口
```

### 错误处理
所有 API 返回格式统一：
```json
{
  "success": false,
  "error": "错误码",
  "message": "人类可读的错误信息"
}
```

### 日志规范
- 请求日志：method, path, user_id, prompt_id, duration_ms
- 错误日志：包含堆栈信息
- 业务日志：用户注册、套餐变更、支付成功

---

## 🧪 测试计划

### 单元测试
- 配额计算逻辑
- 点数消耗算法
- API Key 验证
- 负载均衡选择

### 集成测试
- 完整生成流程（含配额扣除）
- 超时处理
- 后端故障转移
- WebSocket 连接

### 压力测试
- 模拟 100 并发请求
- 队列排队行为验证
- 内存泄漏检查

---

## 📈 未来扩展

- [ ] 支持视频生成（SkyReels-V2）
- [ ] 提示词优化 AI 助手
- [ ] 风格迁移（参考图）
- [ ] 批量历史导出
- [ ] 移动端 App（Flutter)
- [ ] 第三方应用市场（API 接入）
- [ ] 私有云部署版本
- [ ] 灰度发布与 A/B 测试

---

## 📞 联系方式

- 作者：星芒（Starlight）
- 项目：OpenClaw 生态
- 协作：Discord #clawd

---

**文档版本：** v0.2 (2026-03-05)
**最后更新：** 2026-03-05
