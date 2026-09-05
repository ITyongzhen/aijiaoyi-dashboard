# AI交易研究雷达

公开只读的价格行为观察页面。策略数据由私有 `aijiaoyi-engine` 仓库中的确定性程序生成；本仓库只发布脱敏后的候选、图形和公开市场数据。

## 本地预览

先在引擎仓库生成快照：

```bash
python3 scripts/export_dashboard_snapshot.py --output dashboard/site
python3 -m http.server 4173 --directory dashboard/site
```

然后打开 `http://127.0.0.1:4173`。

## GitHub Pages

仓库需要配置：

1. Settings → Pages → Source 选择 **GitHub Actions**。
2. Actions Secret `ENGINE_DEPLOY_KEY`：只读访问私有 `ITyongzhen/aijiaoyi-engine` 的 SSH Deploy Key。
3. 运行 `Publish price-action radar`，之后按北京时间完成K线节奏自动更新。

任何 Telegram Token、模型 Key、SQLite 数据库、聊天记录和 `.env` 都不得进入本仓库或 Pages Artifact。
