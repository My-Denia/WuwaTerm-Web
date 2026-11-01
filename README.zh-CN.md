# WuwaTerm Web

WuwaTerm 公共工作台：查词、术语锁定翻译、审校已有译文，以及保存和继续处理本地稿件。
浏览器仅调用同源 BFF；术语与翻译的权威实现保留在 [Python 主仓](https://github.com/My-Denia/WuwaTerm)。

公测入口：<https://wuwaterm.denia-official.chatgpt.site>。额度共享，尽力服务，没有 SLA。

页面不能确认这次下载已写入磁盘。通过链接离开工作台时，若无法从本次导入的稿件恢复工作，
会先询问；整页刷新依靠浏览器离开提示。浏览器后退等站内历史跳转尚未受保护，可能无提示
丢失未保存稿件。崩溃或强制结束也可能丢失页面内容。详见[隐私边界](docs/privacy-and-llm.md)。

开发使用 Node 24、npm 11.6.2。安装、测试、构建与浏览器验证命令见 [README](README.md)。
跨仓契约由 `contracts/backend-ref.txt` 固定后端提交，继续验证真实 API 响应和标签一致性。
严格响应字段校验继续保留，跨仓变更使用关联 PR；项目工作仍由现有 Linear WuwaTerm Project 统一管理。

本次从主仓 `3c51ca3` 的 `site/` 导入，原始源码 blob 记录于 `migration/source.json`。
旧历史保留在主仓。建仓不等于部署，现网站点资源绑定保持不变。
Python 核心、API、Bot、词库构建、VPS 工具和暂停开发的 Windows 客户端继续留在主仓。
