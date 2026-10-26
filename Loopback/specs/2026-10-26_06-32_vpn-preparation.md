# VPN preparation before creating an RSD tunnel

## Approval / intent
用户于 2026-10-26 批准：修复连接来源设置不生效、builtIn 模式没有检测和自动开启 VPN / LocalDevVPN 的问题。

## Contract
- 先复用已存活会话或 ready RSD 隧道，不为复用场景重配 VPN。
- 新建会话（包括新配对验证 openWith）在发现配对服务前统一准备底层网络。
- builtIn：读取 LocalDevVPN 状态，未启用时使用 expectedState 乐观校验启用；检查 Scripting VPN 状态，未连接时启动；有界等待 LocalDevVPN active/effectiveStatus=active。
- proxyApp：不读取/改写 Scripting VPN 配置，不启动或停止 VPN；外部反射由用户提供。
- 失败给出阶段明确的中英提示；不自动停止 VPN、不回滚全局开关、不反复启动。
- 页面关闭和 releaseTunnel 只释放自身 RSD 资源，不关闭全局 VPN。
- 不修改其他脚本凭据边界。状态 API 仅报告 Scripting 自己的 VPN，不声称能检测任意第三方 VPN。

## Verification
- 新增 kit/vpn.ts，使用文档确认的 getState / setEnabled(expectedState) / start 接口，30 秒整体等待预算。
- DeviceSession.open 在 openPairing 前调用 prepareVPN，覆盖 ensureTunnel、验证连接和新配对验证路径。
- hub 保留 ready attach 优先；VPNPreparationError 不再被 holder 提示覆盖。
- 设置页和中英 README 明确自动启动、副作用、外部模式和不自动停止规则。
- 无真实网络副作用 mock 测试 6/6 通过：外部零调用、启用后启动、ready 幂等、connecting 不重复启动且超时、LocalDev 错误、disconnecting 不重启。
- 全项目 TypeScript diagnostics 通过（最终修改后复查）。
- 未执行真实 VPN 启停，不声称真机链路已验证；首次授权、外部 VPN 切换仍需用户实际验收。

## Remaining boundaries
- 超时不取消已接受的原生操作；准备期间不要修改来源设置。现有 hub 的设置修改与正在打开会话之间的并发失效处理属于既有独立问题，本轮不扩大重构。
- VPN 就绪不保证 host/配对服务可达；保留用户地址，不擅自覆盖。
- 本轮仅修改当前脚本，未自动同步 GitHub 仓库。
