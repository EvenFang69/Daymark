# Daymark

[English](README.md) | [简体中文](README.zh-CN.md)

Daymark 是一个面向工作与生活的私人 AI 记录和复盘系统。你只需要像发微信一样输入，内容可以口语化、零散、重复，也可以直接使用系统语音转文字。Daymark 会用 AI 理解原始表达，整理出进展、判断、问题和下一步；只有当关键歧义会影响以后复盘时，才进行一次有价值的追问，并随着记录积累生成有依据的日复盘和跨周期分析。

系统始终完整保留原文。AI 整理、追问对话、日期修正、复盘报告及其来源记录分别保存，因此任何结论都可以回到当时真正写下的内容，而不是用 AI 总结覆盖历史。

## 项目预览

以下截图全部使用虚构 Demo 数据。

<table>
  <tr>
    <td align="center"><img src="docs/images/daymark-record.png" width="420" alt="AI 整理后的记录"><br><sub>AI 整理后的记录</sub></td>
    <td align="center"><img src="docs/images/daymark-timeline.png" width="420" alt="时间线"><br><sub>时间线</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/daymark-calendar-month.png" width="420" alt="日历月视图"><br><sub>日历月视图</sub></td>
    <td align="center"><img src="docs/images/daymark-calendar-week.png" width="420" alt="日历周视图"><br><sub>日历周视图</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/daymark-calendar-day.png" width="420" alt="日历日视图"><br><sub>日历日视图</sub></td>
    <td align="center"><img src="docs/images/daymark-ask.png" width="420" alt="问自己"><br><sub>问自己</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/daymark-dark.png" width="420" alt="深色模式设置"><br><sub>深色模式</sub></td>
    <td align="center"><img src="docs/images/daymark-review.png" width="420" alt="复盘总结"><br><sub>复盘总结</sub></td>
  </tr>
</table>

## 它如何工作

1. **自然记录**：直接输入或使用系统语音转文字，不需要先选分类，也不需要填写固定表格。
2. **AI 理解整理**：识别实际发生日期、主题、进展、判断、问题、假设和下一步行动。
3. **只追问重要信息**：当某个关键歧义确实会影响未来复盘时，系统只提出一个重点问题，并始终允许跳过。
4. **跨时间复盘**：通过日报、最近 7 天复盘和日历视图，把零散记录连接成真实进展、重复问题、判断变化和下一步调整方向。

## 核心能力

- 以 AI 整理结果为主要阅读内容，同时完整保留原文作为可追溯证据。
- 结合上下文判断是否需要追问，不把记录过程变成机械问卷。
- 智能理解“昨天”“前天”和明确日期，并支持自定义业务日截止时间。
- 提供时间线以及月、周、日三种日历复盘视图。
- 生成有原始记录来源的日报和最近 7 天复盘，结论可以返回对应记录。
- 通过“问自己”基于已保存的历史记录回答问题，而不是依赖模型凭空记忆。
- 将大量重复建议聚合为少数“当前重点”，同时保留原建议和状态历史。
- 支持图片、文档和其他文件与文字记录一起保存。
- 使用本地 SQLite 存储，并支持 JSON、Markdown 和 SQLite 导出，方便备份与迁移。
- 提供适配桌面和手机浏览器的响应式 PWA 界面，并支持浅色与深色模式。

## 环境要求

- Python 3.10 或更高版本
- 一个兼容 OpenAI 的 API 地址、API Key 和可用模型名称
- 应用服务器本身不需要安装第三方 Python 包

## 本地运行

1. 复制配置文件：

   ```bash
   cp .env.example .env
   ```

2. 在 `.env` 中填写兼容 OpenAI 的 API 地址、API Key 和模型名称。

3. 启动 Daymark：

   ```bash
   python3 app.py
   ```

打开 `http://127.0.0.1:8765`。如需在同一网络中的其他设备上使用，请设置 `JOURNAL_HOST=0.0.0.0`，然后打开服务器输出的局域网地址。不要将开发服务器直接暴露到公网。

首次运行会在 `data/journal.sqlite3` 创建一个空的 SQLite 数据库。数据库和上传文件已被 Git 忽略。

Daymark 会在请求 AI 之前先保存原文，因此 API 服务临时失败不会导致记录丢失。但 API Key 仍然是启用 AI 整理、智能追问、复盘报告和历史分析等核心能力的必要配置；无 Key 时仅能作为原文保底保存状态，不代表可以正常体验 Daymark。

## AI 配置

将 `.env.example` 复制为 `.env` 并配置所使用的服务商。不同服务商支持的模型名称不同，请将示例替换为你的账号实际可用模型。

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
