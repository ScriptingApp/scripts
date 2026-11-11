# Spec: TestFlight 申请脚本

## Goal
- 要解决什么问题：为永久 Pro 用户提供一个资料完整性受控的 TestFlight 申请邮件入口。
- 验收结果：页面能选择三张图片；收据图 OCR 预填可编辑 Apple ID 邮箱和订单号；三项截图、邮箱、订单号齐全时可唤起 MailUI。

## Done Contract
- 什么算完成：实现单页申请流程，缺少任一必填项时不能提交，邮件收件人为 `tf@scripting.fun`，三张图作为附件。
- 由什么证明：TypeScript 诊断通过，脚本可预览/运行，代码静态检查覆盖 OCR 提取和表单校验。
- 哪些情况仍算未完成：MailUI 或 Photos 受设备权限/账号配置影响无法在诊断环境中实际发送，不视为代码缺陷。

## Scope
- In: `index.tsx`、`script.json`，项目内 spec。
- Out: 自动发送、服务端验证、改动 TestFlight Manager。

## Facts / Constraints
- 已确认事实：Scripting 提供全局 `Photos.pick`、`Vision.recognizeText`、`MailUI.present`；参考 OCR 规则在 TestFlight Manager/utils/tester_ocr.ts。
- 技术/业务约束：必须由用户最终点击发送；订单号按参考逻辑优先识别 10 位大写字母数字；图片必须附在邮件中。
- 已知风险：Photos picker 返回的 `PHPickerResult` 需要通过其 `loadObject` 获取 UIImage；实际 API 类型需以诊断为准。

## Open Questions
- [ ] PHPickerResult 的图片加载方法在当前运行时的确切声明；先按已有 Scripting 类型提示实现并用诊断校正。

## Restated Understanding
- 我理解当前任务是：做一个申请 TF 的 iOS 风格表单，不替用户发邮件。
- 当前核心目标是：所有必填资料齐全后生成含三张截图的申请邮件。
- 当前边界是：只在当前项目内实现，不修改参考项目。
- 暂不处理：后台上传、资格自动核验、收据真伪验证。

## Goal Alignment Check
- 当前动作是否仍服务于核心目标：是，已读取规范、参考 OCR 和 API 文档。
- 若否，偏差在哪里：无。
- 是否需要调整本轮目标或范围：否。

## Checkpoint Summary
- 当前任务理解：实现 TestFlight 申请表单与 MailUI 流程。
- 当前核心目标：表单校验通过后生成可编辑邮件并附三张截图。
- 当前进度：已完成规范、项目、参考逻辑和 API 调研。
- 下一步 1: 实现页面和 OCR。
- 下一步 2: 运行诊断与预览，修复类型问题。
- 涉及文件 / 模块：`index.tsx`、`script.json`、`specs/`。
- 风险：Photos 返回结果类型；MailUI 附件需 Data。
- 验证方式：get_typescript_diagnostics、scripting-ts preview_ui/run。
- Execution Approval: `Approved`（用户原始请求已明确要求实现）

## Change Log
- 2026-10-19: 建立最小 spec，确认页面、OCR、三图附件和 MailUI 边界。
- 2026-10-19: 收据 OCR 必须识别出订单号才保留截图并显示申请信息；失败时用 Dialog.alert 提示截图不合法。
- 2026-10-19: 申请信息增加确认 footer；上传 row 增加完成图标，选中图片在 Section 内独立下一行等比展示。
- 2026-10-19: 将入口、页面、文案、OCR 工具和截图组件拆分为多个模块，保持功能不变。
- 2026-10-19: 修复邮件正文使用字面量 `\\n` 的问题，改用真正的换行符。
- 2026-11-11: OCR 识别成功填充邮箱/订单号后弹出 `Dialog.confirm` 核对弹窗，列出识别到的邮箱与订单号并提示“信息有误将无法收到 TestFlight 邀请”；取消时在页面留下核对提示；申请信息 footer 同步强调与收据一致。

## Validation
- Self-check: 已覆盖邮箱格式、10 位订单号、三张截图和 Mail 可用性校验；申请信息仅在收据 OCR 识别出订单号后显示并提示确认；OCR 成功后必弹核对弹窗（邮箱未识别时显示“未识别到，请手动填写”）；无订单号或 OCR 异常时清除收据并通过 Dialog.alert 提示截图不合法；上传 row 用蓝色添加/绿色完成图标区分状态，图片在下一行 fit 等比显示；按钮在所有资料满足前禁用；`Device.systemLocale` 控制中文，其他语言回退英文；模块职责已拆分。
- Static checks: 入口、页面、文案、OCR 和截图组件五个模块的 `get_typescript_diagnostics` 均无诊断。
- Runtime / Test: `scripting-ts preview_ui pages/application_view.tsx` 成功渲染。
- Human confirmation: 待用户在真实设备上切换语言、选择图片并确认邮件内容。
- 结果汇总：表单、OCR 订单号门槛、非法截图弹窗、附件、独立截图 Section、确认 footer、上传状态图标、等比图片展示、多语言和按钮状态已实现并通过静态/UI 预览验证；邮件正文换行符已修复。
- 核心目标是否已由证据证明完成：代码层面已证明；真实发送仍需用户设备确认。
- 若未完成，当前剩余差距：真实 Photos 权限、Mail 账户和 OCR 图片验证。
- 剩余风险：运行时权限与 Mail 配置；OCR 结果始终允许用户手动修改。

## Resume / Handoff
- 当前状态：实现完成；已补充独立截图 Section、header/footer、中英文文案和按钮启用条件，静态诊断和 UI 预览通过。
- 当前卡点：未在真实设备上完成 Mail 账户和 Photos 权限下的人工发送验证。
- 下一步唯一动作：在设备上切换中英文系统语言并选择三张真实截图，确认按钮状态、OCR 预填和 MailUI 附件。
- 下一轮核心目标：如真实设备反馈 picker、语言或附件兼容问题，再针对运行时证据修复。
