# WuwaTerm Web

WuwaTerm 公共工作台：查词、术语锁定翻译、审校已有译文，以及保存和继续处理本地稿件。
浏览器仅调用同源 BFF；术语与翻译的权威实现保留在 [Python 主仓](https://github.com/My-Denia/WuwaTerm)。

公测入口：<https://wuwaterm.denia-official.chatgpt.site>。额度共享，尽力服务，没有 SLA。

同一工作台也支持在自己的服务器上私有运行，需配置 Core API 和带认证的 HTTPS 反向代理。
独立运行与 Docker 的配置步骤见[自托管指南](docs/self-hosting.md)。

页面不能确认这次下载已写入磁盘。通过链接离开工作台时，若无法从本次导入的稿件恢复工作，
会先询问。跨页链接使用整页导航，后退、前进和刷新依靠浏览器离开提示；取消离开会保留
当前稿件、决定和报告。崩溃或强制结束也可能丢失页面内容。详见[隐私边界](docs/privacy-and-llm.md)。

开发使用 Node 24、npm 11.6.2。安装、测试、构建与浏览器验证命令见 [README](README.md)。
跨仓契约由 `contracts/backend-ref.txt` 固定后端提交，继续验证真实 API 响应和标签一致性。
严格响应字段校验继续保留，跨仓变更使用关联 PR；项目工作沿用现有 WuwaTerm Project，
跨仓入口见[统一 GitHub Project](https://github.com/users/My-Denia/projects/1)，不另建权威待办。

本次从主仓 `3c51ca3` 的 `site/` 导入，原始源码 blob 记录于 `migration/source.json`。
旧历史保留在主仓。建仓不等于部署，现网站点资源绑定保持不变。
主仓负责权威翻译、术语审校、HTTP API、词库构建校验与通用部署恢复；
[Telegram](https://github.com/My-Denia/WuwaTerm-Telegram) 和
[Windows](https://github.com/My-Denia/WuwaTerm-Windows) 独立维护产品源码与交付，
分别复用固定 Core 包和受保护 HTTP API。公开与自托管 Web 共用本仓工作台，Sites 是托管目标。
源码、正式发布和生产采用分别记录。
