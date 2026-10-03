# 把账单界面挂进 DSH 左侧栏（面板集成说明）

这是 2026-10-03 实装的做法与踩坑记录。**这份文档是"以后重建/排查"的唯一依据**，删插件前请先读它。

## 整体结构

```
DSH 桌面端
 ├── 左侧栏「账单」条目  ← dsh-plugin-billing-bot 注册的 slot
 └── 主区域面板            ← 面板内 iframe 嵌入 ↓
        http://127.0.0.1:8790/?token=…   ← billing-bot 自己的本地网页界面
```

DSH 与 billing-bot 之间**没有任何进程耦合**，只有"浏览器里的一个 iframe"。所以：

- billing-bot 挂了/没启动 → 面板空白（不是 DSH 的问题）；
- DSH 重启 → billing-bot 不受影响（前提是它独立运行，见下）。

## 一、插件包（DSH 侧）

位置：`<你的用户目录>\dsh-plugins\dsh-plugin-billing-bot\`

| 文件 | 作用 |
|---|---|
| `package.json` | 清单：`dsh.bundle.patch` + `dsh.client.inject` + `icon` |
| `cordis.patch.yml` | 注册行：`- insert: [{ id: ui-billing-bot, name: 'dsh-plugin-billing-bot' }]` |
| `lib/client.js` | 浏览器侧：注册侧栏条目 + 主区域面板 |
| `lib/index.js` | 宿主侧入口（纯 UI 插件，有意留空、异常不外抛） |
| `icon.svg` | 条目图标 |

### 客户端插件的契约（照抄自 `@linxin666/dsh-client-ui-task-board`）

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-billing-bot',
  factory: (require) => {
    var react = require('react');           // 宿主提供，无需打包
    function apply(ctx) {
      var slots = ctx.slots;
      // 左侧栏的一个独立条目（Icon 作为第二个参数）
      slots.inject('sidebar.panellist', () => slots.register(
        { name: 'sidebar.panellist', id: 'billing-bot', order: 45, label: () => '账单' },
        BillingBotIcon));
      // 点开后的主区域页面（Component 作为第二个参数）
      slots.inject('main', () => slots.register({ name: 'main', key: 'billing-bot' }, BillingBotPanel));
    }
    exports.apply = apply;
    exports.inject = ['slots'];              // 只声明需要的服务
    return module.exports;
  }
});
```

要点：

- **不需要构建步骤**：用 `react.createElement` 代替 JSX，直接手写 JS。
- `slots.inject(seat, cb)` 的回调**只在声明该 seat 的外壳插件就绪后**才执行；外壳没有这个 seat 时，插件只是"不出现"，不会让 DSH 启动失败。
- seat 名：`sidebar.panellist`（左侧栏条目）、`main`（主区域页面）。
- 一定要用 `try/catch` 包住 `apply`：一个只加侧栏条目的插件不该有能力弄坏宿主。

### 安装与生效

1. profile 清单 `<你的用户目录>\.dsh\profiles\desktop\package.json` **两处都要写**：
   - `dependencies`: `"dsh-plugin-billing-bot": "file:C:/Users/lenovo/dsh-plugins/dsh-plugin-billing-bot"`
   - `dsh.profile.bundles`: 追加 `"dsh-plugin-billing-bot"`
2. 在 profile 目录执行 `pnpm install`；
3. **在 DSH 桌面端内重启**（`POST /plugin-console/restart` 在桌面端托管时会被拒）；
4. 验证：`GET http://127.0.0.1:19387/plugin-console/state` 应出现
   `rowId=ui-billing-bot · module=dsh-plugin-billing-bot · enabled=true · phase=active`。

⚠️ **`file:` 依赖装的是副本，不是软链**。改了插件源码后必须同步覆盖
`~\.dsh\profiles\desktop\node_modules\dsh-plugin-billing-bot\` 下那一份，否则"改了没反应"。

⚠️ 改插件源码/面板 URL 时要同时改**两处**：
`dsh-plugins\dsh-plugin-billing-bot\lib\client.js` 与 profile 下的安装副本。

## 二、billing-bot 侧的两个前提

1. **端口与令牌必须固定**：面板里的 iframe URL 是写死的。
   配置项 `server.port`（默认 8790）与 `server.token`（首次启动生成后写盘），
   都能在「设置 → 本地界面」里看到。
   早期版本端口随机、令牌每次重启重生成 —— 那样嵌出去的链接第二天就失效。
2. **服务必须独立于 DSH 运行**：如果把它当成 DSH 会话的后台任务启动，
   用户重启 DSH 时会被一起杀掉，面板随即变白。
   现在用**启动文件夹**：
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\billing-bot-ui.cmd`
   （删掉该文件即可取消自启）。

> 为什么不用计划任务：`New-ScheduledTaskTrigger -AtLogOn` 在本机注册被拒
> （`Access is denied`，需要管理员）。启动文件夹等效且免管理员。

## 三、排查清单（面板空白时按顺序查）

| 现象 | 检查 | 处置 |
|---|---|---|
| 面板整块白 | 端口是否在听：`Get-NetTCPConnection -LocalPort 8790 -State Listen` | 启动服务 |
| 面板白但端口在听 | 直接浏览器打开 `http://127.0.0.1:8790/?token=…` | 能开说明是 iframe 层的问题（CSP/令牌），不能开说明服务内部报错 |
| 侧栏没有「账单」 | `/plugin-console/state` 里有没有 `ui-billing-bot` | 没有 → 清单没写全 / 没跑 pnpm / 没重启 DSH |
| 侧栏有条目但点开无反应 | `lib/client.js` 里 seat 名是否与当前 DSH 版本一致 | 查同版本已装插件的 `lib/client.js` 用法 |
| 令牌变了 | 设置页「本地访问令牌」 | 更新插件里的 `BILLING_BOT_URL`（两处） |

## 四、改动记录

- 2026-10-03：实装。billing-bot 增加 `server.port` / `server.token` 固定化 + 新增启动项；
  插件包上线，左侧栏出现「账单」独立条目，面板嵌入现有网页界面。
- 2026-10-03：界面视觉重构（`src/server/pages.ts` 的 `STYLE` + `layout`）：
  设计令牌体系、明暗双主题、胶囊导航（当前页高亮）、指标卡、表格数字右对齐等宽、
  主次按钮分明、配置分组中文标题、时间与状态人话化。
