import {
  Button,
  List,
  Navigation,
  NavigationStack,
  ProgressView,
  Section,
  Text,
  TextField,
  useState,
} from "scripting"
import { RECIPIENT, copy } from "../constants/copy"
import { ScreenshotSlot } from "../components/screenshot_slot"
import { extractOCRFields, isValidEmail, isValidOrderId } from "../utils/ocr"

export default function ApplicationView() {
  const dismiss = Navigation.useDismiss()
  const [email, setEmail] = useState("")
  const [orderId, setOrderId] = useState("")
  const [receiptImage, setReceiptImage] = useState<UIImage | null>(null)
  const [proImage, setProImage] = useState<UIImage | null>(null)
  const [reviewImage, setReviewImage] = useState<UIImage | null>(null)
  const [recognizing, setRecognizing] = useState(false)
  const [message, setMessage] = useState("")
  const [receiptRecognized, setReceiptRecognized] = useState(false)
  const canSubmit = receiptRecognized && isValidEmail(email) && isValidOrderId(orderId)
    && Boolean(receiptImage && proImage && reviewImage)

  const confirmRecognizedFields = async (recognizedEmail: string | null, recognizedOrder: string): Promise<void> => {
    const verified = await Dialog.confirm({
      title: copy.ocrVerifyTitle,
      message: [
        copy.ocrVerifyMessage, "",
        `${copy.email}：${recognizedEmail ?? copy.emailNotRecognized}`,
        `${copy.order}：${recognizedOrder}`,
      ].join("\n"),
      confirmLabel: copy.ocrVerifyConfirm,
      cancelLabel: copy.ocrVerifyCancel,
    })
    if (!verified) setMessage(copy.ocrVerifyHint)
  }

  const pickImage = async (kind: "receipt" | "pro" | "review"): Promise<void> => {
    try {
      const picked = await Photos.pickPhotos(1)
      const image = picked?.[0] ?? null
      if (!image) return
      if (kind === "receipt") {
        setReceiptImage(null)
        setReceiptRecognized(false)
        setEmail("")
        setOrderId("")
        setRecognizing(true)
        setMessage(copy.recognizing)
        let recognized: { email: string | null, orderId: string } | null = null
        try {
          const result = await Vision.recognizeText(image, {
            recognitionLevel: "accurate",
            recognitionLanguages: ["zh-Hans", "en-US"],
            usesLanguageCorrection: false,
          })
          const fields = extractOCRFields(result.text)
          if (!fields.orderId) {
            setReceiptImage(null)
            setReceiptRecognized(false)
            setMessage(copy.invalidReceipt)
            await Dialog.alert(copy.invalidReceipt)
            return
          }
          setReceiptImage(image)
          setReceiptRecognized(true)
          if (fields.email) setEmail(fields.email)
          setOrderId(fields.orderId)
          setMessage(copy.ocrSuccess)
          recognized = { email: fields.email, orderId: fields.orderId }
        } catch {
          setReceiptImage(null)
          setReceiptRecognized(false)
          setMessage(copy.ocrFailed)
          await Dialog.alert(copy.invalidReceipt)
        } finally {
          setRecognizing(false)
        }
        if (recognized) await confirmRecognizedFields(recognized.email, recognized.orderId)
      } else if (kind === "pro") {
        setProImage(image)
      } else {
        setReviewImage(image)
      }
    } catch (error) {
      await Dialog.alert(`${copy.chooseFailed}${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const submit = async (): Promise<void> => {
    const normalizedEmail = email.trim().toLowerCase()
    const normalizedOrderId = orderId.trim().toUpperCase()
    if (!isValidEmail(normalizedEmail)) {
      await Dialog.alert(copy.invalidEmail)
      return
    }
    if (!isValidOrderId(normalizedOrderId)) {
      await Dialog.alert(copy.invalidOrder)
      return
    }
    if (!receiptImage || !proImage || !reviewImage) {
      await Dialog.alert(copy.missingImages)
      return
    }
    if (!MailUI.isAvailable) {
      await Dialog.alert(copy.mailUnavailable)
      return
    }

    const receiptData = receiptImage.toPNGData()
    const proData = proImage.toPNGData()
    const reviewData = reviewImage.toPNGData()
    if (!receiptData || !proData || !reviewData) {
      await Dialog.alert(copy.attachmentFailed)
      return
    }

    const result = await MailUI.present({
      toRecipients: [RECIPIENT],
      subject: `${copy.subject} - ${normalizedEmail}`,
      body: [
        copy.bodyIntro, "", `${copy.email}: ${normalizedEmail}`, `${copy.order}: ${normalizedOrderId}`,
        "", copy.attachmentList, "", copy.thanks,
      ].join("\n"),
      attachments: [
        { data: receiptData, mimeType: "image/png", fileName: "购买收据.png" },
        { data: proData, mimeType: "image/png", fileName: "Scripting-PRO.png" },
        { data: reviewData, mimeType: "image/png", fileName: "App-Store-五星好评.png" },
      ],
    })
    if (result === "failed") setMessage(copy.failed)
    else if (result === "sent") setMessage(copy.sent)
    else if (result === "saved") setMessage(copy.saved)
    else setMessage(copy.cancelled)
  }

  return (
    <NavigationStack>
      <List
        navigationTitle={copy.title}
        navigationBarTitleDisplayMode="inline"
        toolbar={{ cancellationAction: <Button title={copy.close} action={dismiss} /> }}
      >
        <Section header={<Text>{copy.introHeader}</Text>}>
          <Text>{copy.intro}</Text>
          <Text foregroundStyle="orange">{copy.tip}</Text>
          <Text foregroundStyle="secondaryLabel">{copy.receiptWarning}</Text>
        </Section>
        {receiptRecognized ? <Section header={<Text>{copy.info}</Text>} footer={<Text>{copy.infoFooter}</Text>}>
          <TextField title={copy.email} prompt={copy.emailPrompt} value={email} onChanged={setEmail} />
          <TextField title={copy.order} prompt={copy.orderPrompt} value={orderId} onChanged={setOrderId} />
        </Section> : null}
        <Section header={<Text foregroundStyle="systemBlue">{copy.receiptHeader}</Text>} footer={<Text>{copy.receiptFooter}</Text>}>
          <ScreenshotSlot title={copy.receiptHeader} image={receiptImage} onPick={() => pickImage("receipt")} />
        </Section>
        <Section header={<Text foregroundStyle="purple">{copy.proHeader}</Text>} footer={<Text>{copy.proFooter}</Text>}>
          <ScreenshotSlot title={copy.proHeader} image={proImage} onPick={() => pickImage("pro")} />
        </Section>
        <Section header={<Text foregroundStyle="orange">{copy.reviewHeader}</Text>} footer={<Text>{copy.reviewFooter}</Text>}>
          <ScreenshotSlot title={copy.reviewHeader} image={reviewImage} onPick={() => pickImage("review")} />
        </Section>
        {recognizing ? <Section><ProgressView title={copy.recognizing} /></Section> : null}
        {message ? <Section><Text foregroundStyle="secondaryLabel">{message}</Text></Section> : null}
        <Section>
          <Button title={copy.button} systemImage="envelope" action={submit} disabled={!canSubmit} />
          <Text foregroundStyle="secondaryLabel">{copy.buttonHint}</Text>
        </Section>
      </List>
    </NavigationStack>
  )
}
