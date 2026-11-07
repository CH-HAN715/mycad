# Mycad

工业级铝型材框架设计引擎 · agent-first CLI。

自算截面特性 → 框架求解 → 连接件选型 → 强度/挠度校核 → BOM / 定尺下料 / DXF 图纸，一条命令行流水线。几何与计算引擎零运行时第三方依赖，每个工程量可追溯到公式、输入、单位与来源。

## 状态声明（请先读这段）

- 当前为 **0.x 早期版本**，接口与文件格式随时可能变化。
- **不是生产级软件**：孔位图是加工参考图，不是可签收的下厂图纸；投产前必须由工程师补齐工艺并确认。差距清单见 [docs/生产级差距清单.md](docs/生产级差距清单.md)。
- **不做结构认证**：校核输出仅覆盖标准工况解析解，报告中的默认限值标注「工程惯例，非规范条文」。任何输出都不构成「符合 GB/ISO xxx」的合规声明。

## 快速开始

要求 Node.js >= 24。

```bash
pnpm install

# 截面特性（内置预设）
pnpm cli section --preset eu4040

# 截面计算报告（公式、假设、局限、免责）
pnpm cli report --preset eu4040 --out report.md

# 框架 → 连接选型 → BOM/下料 → 图纸
pnpm cli frame --file frame.json
pnpm cli connect --file frame.json
pnpm cli bom --file frame.json --stock 6000 --kerf 3
pnpm cli drawing --file frame.json --out members.dxf

# 标准工况校核（输入为工况 JSON，见 help）
pnpm cli check --file case.json

# 本地网页设计台（仅监听 127.0.0.1，含 3D 预览）
pnpm cli serve
```

完整用法：`pnpm cli help`。Linux 桌面可用 `scripts/launch-mycad.sh` 双击启动。

## 验证

```bash
pnpm verify         # 类型检查 + 全部测试
pnpm bench          # 手算对照算例
pnpm release:check  # 发布一致性自检
```

数值计算改动必须附可手算复核的对照算例（`tests/fixtures/` 与 `src/verify/`），没有算例不合并。

## 架构

八层，依赖只能自上而下：几何底座 → 截面特性 → 连接 → 装配 → 生产 → 校核 → 输出 → 交互。详见 [docs/工业级范围与里程碑.md](docs/工业级范围与里程碑.md)。

## 许可证

[Apache-2.0](LICENSE)。第三方依赖许可证逐条登记于 [docs/第三方许可证.md](docs/第三方许可证.md)（当前仅 vendored three.js，MIT，全文随附）。

贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。