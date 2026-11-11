import { Device } from "scripting"

export const RECIPIENT = "tf@scripting.fun"

export type Copy = {
  title: string; close: string; introHeader: string; intro: string; tip: string; receiptWarning: string; info: string
  email: string; emailPrompt: string; order: string; orderPrompt: string; infoFooter: string
  receiptHeader: string; receiptFooter: string; proHeader: string; proFooter: string
  reviewHeader: string; reviewFooter: string; select: string; replace: string
  recognizing: string; ocrSuccess: string; ocrEmpty: string; ocrFailed: string; invalidReceipt: string; chooseFailed: string
  ocrVerifyTitle: string; ocrVerifyMessage: string; ocrVerifyConfirm: string; ocrVerifyCancel: string
  ocrVerifyHint: string; emailNotRecognized: string
  invalidEmail: string; invalidOrder: string; missingImages: string; mailUnavailable: string
  attachmentFailed: string; button: string; buttonHint: string; subject: string
  bodyIntro: string; attachmentList: string; thanks: string; sent: string; saved: string; failed: string; cancelled: string
}

const ZH: Copy = {
  title: "申请 TestFlight", close: "关闭", introHeader: "申请说明", intro: "永久 Pro 用户（含兑换码激活用户）可申请 TestFlight 测试资格。",
  tip: "💡 TestFlight 版本直接购买永久会员即可激活 Pro（无需支付费用）", receiptWarning: "请确保购买收据截图同时包含 Apple ID 邮箱及订单号，否则申请将不予处理。",
  info: "申请信息", email: "Apple ID 邮箱", emailPrompt: "请输入 Apple ID 邮箱", order: "订单号", orderPrompt: "10 位字母数字订单号", infoFooter: "请确认 Apple ID 邮箱和订单号与收据完全一致，否则无法收到 TestFlight 邀请。",
  receiptHeader: "购买收据截图", receiptFooter: "必须包含 Apple ID 邮箱和订单号；选择后将自动识别并填充下方信息。",
  proHeader: "Scripting PRO 页面截图", proFooter: "请提供能显示当前永久 Pro 激活状态的页面截图。",
  reviewHeader: "App Store 五星好评截图", reviewFooter: "截图必须能看到五星评价和简短评论。", select: "选择截图", replace: "已选择，点击可更换",
  recognizing: "正在识别收据中的邮箱和订单号…", ocrSuccess: "已尝试从收据截图填充资料，请核对后继续。", ocrEmpty: "未识别到邮箱或订单号，请手动填写或更换清晰截图。",
  ocrVerifyTitle: "请核对邮箱和订单号", ocrVerifyMessage: "自动识别可能出错：请逐字核对 Apple ID 邮箱和订单号是否与购买收据一致。信息有误将无法收到 TestFlight 邀请。", ocrVerifyConfirm: "我已核对无误", ocrVerifyCancel: "返回修改", ocrVerifyHint: "请对照收据核对或修改上方邮箱和订单号，信息有误将无法收到邀请。", emailNotRecognized: "未识别到，请手动填写",
  ocrFailed: "收据识别失败，请重新选择截图。", invalidReceipt: "截图不合法，请选择包含订单号的购买收据截图。", chooseFailed: "选择图片失败：", invalidEmail: "请填写有效的 Apple ID 邮箱。",
  invalidOrder: "请填写 10 位字母数字订单号，并确认订单号无误。", missingImages: "请先选择三张必填截图。", mailUnavailable: "当前设备没有可用的 Mail 邮件账户，无法唤起申请邮件。",
  attachmentFailed: "图片无法转换为邮件附件，请重新选择截图。", button: "申请TestFlight", buttonHint: "点击后会打开 Mail 邮件编辑窗口，最终发送由你确认。",
  subject: "TestFlight 申请", bodyIntro: "您好，我希望申请 Scripting TestFlight 测试资格。", attachmentList: "附件已包含：购买收据截图、Scripting PRO 页面截图、App Store 五星好评及短评截图。",
  thanks: "感谢！", sent: "邮件已发送，感谢你的申请！", saved: "邮件已保存为草稿，请在 Mail 中确认发送。", failed: "邮件发送失败，请检查 Mail 账户配置。", cancelled: "已取消邮件发送。",
}

const EN: Copy = {
  title: "Apply for TestFlight", close: "Close", introHeader: "Application Guide", intro: "Permanent Pro users, including users activated with a redemption code, may apply for TestFlight access.",
  tip: "💡 The TestFlight version activates Pro when you purchase a lifetime membership directly (no extra payment required).", receiptWarning: "The purchase receipt screenshot must include both the Apple ID email and order number, or the application cannot be processed.",
  info: "Application Information", email: "Apple ID Email", emailPrompt: "Enter your Apple ID email", order: "Order Number", orderPrompt: "10-character alphanumeric order number", infoFooter: "Make sure the Apple ID email and order number exactly match your receipt, otherwise you will not receive the TestFlight invitation.",
  receiptHeader: "Purchase Receipt Screenshot", receiptFooter: "It must include the Apple ID email and order number. The fields below will be filled automatically after selection.",
  proHeader: "Scripting PRO Page Screenshot", proFooter: "Provide a screenshot showing your current lifetime Pro activation status.",
  reviewHeader: "App Store Five-Star Review Screenshot", reviewFooter: "The screenshot must show the five-star rating and a short review.", select: "Select Screenshot", replace: "Selected — tap to replace",
  recognizing: "Recognizing the email and order number…", ocrSuccess: "The receipt was used to fill in the fields. Please review them before continuing.", ocrEmpty: "No email or order number was recognized. Please enter them manually or choose a clearer screenshot.",
  ocrVerifyTitle: "Check the email and order number", ocrVerifyMessage: "Automatic recognition can misread text: please verify character by character that the Apple ID email and order number match your purchase receipt. Incorrect details mean you will not receive the TestFlight invitation.", ocrVerifyConfirm: "Verified", ocrVerifyCancel: "Edit", ocrVerifyHint: "Please check or correct the email and order number above against your receipt; incorrect details mean no invitation.", emailNotRecognized: "Not recognized — please enter manually",
  ocrFailed: "Receipt recognition failed. Please select another screenshot.", invalidReceipt: "Invalid screenshot. Please select a purchase receipt screenshot containing the order number.", chooseFailed: "Could not select the image: ", invalidEmail: "Please enter a valid Apple ID email.",
  invalidOrder: "Please enter a 10-character alphanumeric order number.", missingImages: "Please select all three required screenshots first.", mailUnavailable: "No Mail account is available on this device.",
  attachmentFailed: "The images could not be converted into attachments. Please select them again.", button: "Apply for TestFlight", buttonHint: "Mail will open for your review; you will confirm the final sending.",
  subject: "TestFlight Application", bodyIntro: "Hello, I would like to apply for Scripting TestFlight access.", attachmentList: "Attachments: purchase receipt, Scripting PRO page, and App Store five-star review screenshots.",
  thanks: "Thank you!", sent: "The email was sent. Thank you for applying!", saved: "The email was saved as a draft. Please confirm it in Mail.", failed: "The email failed to send. Please check your Mail account.", cancelled: "Email sending was cancelled.",
}

export const copy: Copy = Device.systemLocale.toLowerCase().startsWith("zh") ? ZH : EN
