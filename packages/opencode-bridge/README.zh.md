# OpenCode → Statusline 轻量桥接

[English](README.md) · 社区接入版 0.1.0

复用现有 `opencode-quota` 的额度数据，加密同步到 Statusline 官方手机 App
和小组件。只运行一个 OpenCode 服务端插件，无需安装 Desktop Companion。

## 安装

已验证目标：OpenCode **2.2.7**、Quota **6.2.2**；命令行需要 Node.js **22.13+**。

```sh
git clone --branch feat/opencode-bridge --single-branch https://github.com/YuYiChyan/statusline.git
cd statusline
npm ci --ignore-scripts
npm test
npm run check
```

在全局 `~/.config/opencode/opencode.json(c)` 的 `plugins` 数组中保留原有插件，
追加仓库的绝对目录：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@slkiser/opencode-quota@6.2.2",
    {
      "package": "/你的绝对目录/statusline",
      "options": { "pollMs": 60000, "maxAgeMs": 900000 }
    }
  ]
}
```

配置保存后自动热加载。可让 OpenCode 调用 `statusline_bridge_status` 查看状态。
也可通过 `npm pack` 生成只包含桥接源码、文档和许可证的安装包；尚未发布 npm。

## 连接手机

```sh
node packages/opencode-bridge/src/cli.js pair
```

打开输出中指定的本地 HTML 页面，复制私人链接，在手机 Statusline 的设备配对
界面粘贴并连接。Mac 与 iPhone 可用通用剪贴板。链接有效期 **10 分钟**，只能
使用一次。页面包含密钥，请保密；命令不会把链接或密钥写入终端/AI 对话。

```sh
node packages/opencode-bridge/src/cli.js status
node packages/opencode-bridge/src/cli.js disconnect
```

链接过期或更换手机时，先 `disconnect`，再 `pair`。断开操作先删除远端频道，
成功后删除本地凭据与配对页。清理失败时保留已落盘的恢复状态；若首次写盘和
远端清理同时失败，返回 `pairing_cleanup_failed`，空频道只能等待远端到期。

## 支持范围

- OpenAI 订阅 → Codex：`openai.weekly` / `openai.five_hour`。
- Google AGY Gemini → Antigravity：`google-agy.gemini.weekly` / `.five_hour`。
- 原生 Anthropic 通用计划 → Claude：`anthropic.weekly` / `.five_hour`。
  手机是否展示 Claude 取决于实际安装版本。
- API 余额、月度额度、模型专属桶和 AGY 第三方 Claude/GPT 池不会混入。

默认每 **60 秒**读取 Quota 的 `snapshot({})`，仅在服务采样发生变化时发布。
Quota 6.2.2 的这个接口会返回缓存，也可能让 Quota 按原有限流与单飞规则启动
正常到期检查；桥接不调用强制 `refresh()`，也不直接访问模型或供应商接口。

保留真实采样时间。错误或超过 **15 分钟**的样本标为不可用，不制造新鲜数据。
之前出现过的服务临时消失时仍保留为不可用，避免把认证/网络错误误当成删除。
用 `services` 选项明确指定保留哪些服务，空数组表示移除所有服务。

多个账号不会合并或随意取第一个。可在本地配置中精确指定 Quota 的账号字符串：

```jsonc
"options": {
  "accounts": { "codex": "QUOTA中显示的精确账号字符串" },
  "services": ["codex", "antigravity", "claude"],
  "pollMs": 60000,
  "maxAgeMs": 900000
}
```

账号选择信息不会上传。各项目应使用一致的全局选项；首次发布后绑定 Quota
来源范围，其他范围会返回 `source_scope_changed`，重新配对才能主动换源。

## 本地状态与验证

状态位于 `$STATUSLINE_BRIDGE_HOME`，或
`$XDG_DATA_HOME/opencode/statusline-bridge`，默认
`~/.local/share/opencode/statusline-bridge`。POSIX 目录 0700、文件 0600。
自定义路径时，插件的 `stateDirectory` 和 CLI 的 `--state-dir` 要一致。
密钥存于私人文件，并非系统钥匙串；Windows 需采用对应文件权限保护。

跨项目通过文件锁共享去重、递增序号和退避状态。AES-256-GCM 与官方测试向量
完全匹配，密钥不发送给 relay。兼容 services-v1；旧 relay 仅能接收有效 Codex
周额度，无法清除旧快照，但保留原时间戳。`--relay` 可指定自建 HTTPS relay，
但正式手机 App 只信任自身内置地址，配对链接不能覆盖它。

```sh
node packages/opencode-bridge/src/cli.js smoke
```

该命令只用模拟数据创建临时频道，验证加密发布→读取解密→删除，不会认领用户
手机的配对。协议/真实 relay 往返与 OpenCode 加载验证，不等于手机实机验收；
**手机及小组件实测仍待完成**。OpenCode 运行时停止或项目被卸载后同步停止；
iOS 小组件刷新由系统安排，非实时推送。本插件不安装唤醒服务或额度重置推送。
