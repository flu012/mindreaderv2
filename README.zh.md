<div align="center">

# MindReader V2

**让你的AI拥有一个看得见、管得了、能自我进化的记忆系统。**

[English](README.md) | [中文](README.zh.md)

![MindReader 图谱视图](docs/images/mind%20graph%20view.png)

</div>

---

## AI记忆的痛点

AI助手在对话之间会遗忘一切。现有的解决方案——向量数据库、RAG管道、记忆插件——都存在相同的问题：

- **不可见** — 记忆被埋在数据库中，你看不到也检查不了
- **不可控** — 无法编辑、合并或删除单条记忆
- **混乱** — 重复、矛盾和过时信息堆积，无人清理
- **静态** — 系统只知道你明确告诉它的内容

## MindReader 有何不同

MindReader 是一个**个人知识图谱**，让你对AI的记忆拥有完整的可视化能力和掌控权。

### 可视化记忆图谱

以交互式图谱查看你的整个记忆全景。节点是实体（人物、项目、工具），边是关系。缩放、过滤、点击探索。不再是黑盒。

![图谱可视化](docs/images/mind%20graph%20view.png)

### 完全手动掌控

点击任意实体即可编辑摘要、标签和分类。合并重复项。创建或删除关系。删除前预览影响范围。你的记忆，你做主。

<p align="center">
<img src="docs/images/manual%20link%20memory.png" width="300" alt="关联实体">
<img src="docs/images/manual%20merge%20memory.png" width="300" alt="合并实体">
</p>

### 自我进化 — 会自己生长的记忆

选中任意节点，点击 **Evolve（进化）**。MindReader 会将其发送给具备网络搜索能力的LLM，研究该实体、发现相关的人物/项目/概念、建立关系——所有结果实时流式呈现在图谱上。

https://github.com/user-attachments/assets/4a93cef0-e48e-464d-a70c-1759d16c5de2

> *单次进化通常能发现10-25个新实体和关系，将一个孤立节点变成丰富的知识集群。*

### 自动维护

LLM驱动的后台维护保持图谱整洁：自动分类、自动打标、重复检测、关系修复、孤立清理——无需任何手动操作。

![维护中心](docs/images/memory%20automastically%20clean%20up.png)

### 多视图模式

以列表、时间线、图谱、分类或活动日志等多种方式浏览你的知识。

<p align="center">
<img src="docs/images/node%20list%20view.png" width="400" alt="列表视图">
<img src="docs/images/node%20creatioon%20timeline.png" width="400" alt="时间线视图">
</p>

![分类视图](docs/images/node%20categorisation%20view.png)

---

## 如何与 OpenClaw 配合使用

MindReader 是 [OpenClaw](https://github.com/openclaw) 的一等公民扩展。安装一次，之后每次对话都会自动构建你的知识图谱。

- **自动捕获** — 从对话中默默提取实体、事实和关系
- **自动回忆** — 代理回复前，自动检索相关记忆并注入上下文
- **工具调用** — 代理可以显式搜索、存储和列出记忆
- **可视化界面** — 随时访问完整的图谱浏览器 `http://localhost:18900`

> 只需自然地与你的代理对话。MindReader 会处理一切。

---

## 快速开始

```bash
git clone https://github.com/flu012/mindreaderv2.git
cd mindreaderv2
npm run setup    # 交互式向导
npm start        # http://localhost:18900
```

> **[完整安装指南 →](docs/quickstart.md)**

### 前置条件

- **Node.js** 18+
- **Python** 3.11+
- **Docker**（用于 Neo4j 数据库）
- **LLM API 密钥**（以下任一提供商）

### 支持的 LLM 提供商

| 提供商 | 默认模型 | 网络搜索 | 备注 |
|---|---|---|---|
| OpenAI | `gpt-4o-mini` | 否 | 最广泛可用 |
| DashScope（阿里巴巴） | `qwen3.5-flash` | 是（内置） | 自我进化功能的最佳选择 |
| Anthropic | `claude-sonnet-4-6` | 否 | 原生 API 支持 |

> 自我进化功能使用支持内置网络搜索的模型（如 DashScope 的 Qwen 系列）效果显著更好。

---

## 文档

- **[快速开始指南](docs/quickstart.md)** — 分步安装、提供商设置、OpenClaw 集成、故障排除
- **[技术参考](docs/technical.md)** — 架构、预处理管道、配置、CLI参考、开发

---

## 免责声明

MindReader V2 是一个用于个人使用和研究的实验性项目。按原样提供，不保证数据完整性、安全性或可用性。记忆数据存储在本地 Neo4j 中——请定期备份数据库。LLM 生成的内容（自动分类、进化结果、提取的事实）可能包含不准确之处，重要记忆请手动审核。`.env` 中的 API 密钥和凭据以明文存储——请勿将此文件提交到版本控制。

## 许可证

MIT
