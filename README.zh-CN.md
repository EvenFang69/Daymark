# Daymark

[English](README.md) | [简体中文](README.zh-CN.md)

Daymark 是一个本地优先的个人 AI 记录与复盘系统。它将原始记录作为证据保存，让 AI 模型整理杂乱的自然语言输入，并生成可追溯的日报和周报。

## 项目预览

以下截图全部使用虚构 Demo 数据。

<table>
  <tr>
    <td align="center"><img src="docs/images/daymark-record.png" width="420" alt="AI 整理后的记录"><br><sub>AI 整理后的记录</sub></td>
    <td align="center"><img src="docs/images/daymark-timeline.png" width="420" alt="时间线"><br><sub>时间线</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/daymark-review.png" width="420" alt="日历复盘"><br><sub>日历复盘</sub></td>
    <td align="center"><img src="docs/images/daymark-ask.png" width="420" alt="问自己"><br><sub>问自己</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/daymark-dark.png" width="420" alt="深色模式设置"><br><sub>深色模式</sub></td>
    <td></td>
  </tr>
</table>

## 功能

- 聊天式记录，在 AI 处理前先保存原始文字。
- 后台 AI 分析，使用结构化 JSON 输出，并可选择性地进行追问。
- 支持日期提示、业务日截止时间、时间线、日历复盘、日报和周报以及来源链接。
- “当前重点”聚合功能可以压缩重复的下一步行动，同时保留其历史记录。
- 支持图片、文档和其他文件附件。
- 使用 SQLite 存储，支持 JSON、Markdown 和 SQLite 导出，并提供适合 PWA 的响应式界面。
- 无需 AI Key 也可使用：记录仍然可用，且绝不会被虚假的 AI 摘要替代。

## 环境要求

- Python 3.10 或更高版本
- 基础应用不需要安装第三方 Python 包
- AI 处理可选使用兼容 OpenAI 的 API

## 本地运行

```bash
cp .env.example .env
python3 app.py
```

打开 `http://127.0.0.1:8765`。如需在同一网络中的其他设备上使用，请设置 `JOURNAL_HOST=0.0.0.0`，然后打开服务器输出的局域网地址。不要将开发服务器直接暴露到公网。

首次运行会在 `data/journal.sqlite3` 创建一个空的 SQLite 数据库。数据库和上传文件已被 Git 忽略。

## AI 配置

将 `.env.example` 复制为 `.env`，然后设置：

```dotenv
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-key
OPENAI_MODEL_SIMPLE=gpt-4o-mini
OPENAI_MODEL_REASONING=gpt-4o
OPENAI_MODEL_REPORT=gpt-4o-mini
OPENAI_MODEL_LONG=gpt-4o
```

请将 `.env` 保留在本地。切勿提交 API Key、Token、密码、个人数据库、导出文件、日志或上传文件。

## 数据与隐私

本应用面向个人、本地优先的使用方式。SQLite 是原始记录、对话消息、AI 版本、报告、修正、关系、建议和聚合结果的真实数据源。导出的数据可用于迁移和测试。公开仓库不包含个人数据库或真实用户记录。

用于生产环境时，请将应用置于 HTTPS 后方，把数据库保存在持久化的私有存储卷中，并在仓库之外配置备份。

## 测试

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.cjs
```

测试套件使用临时数据库和虚构示例文本。

## 许可证

MIT。参见 [LICENSE](LICENSE)。
