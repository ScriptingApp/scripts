// image mounter：另一种挂载开发者镜像的方式，也是唯一能问“现在有没有挂载”的地方。
//
// cryptex 和 mounter 都认为 `/System/Developer` 是自己的；在 mounter 已挂载时再装
// cryptex 会被拒绝（`mkdir custom mount path ... File exists`），所以安装前先问这里。

import { isPlistDict } from "../plist";
import type { DdiLink } from "./link";

/** mounter 在 RSD 服务表里的名字；它本身不需要开发者镜像。 */
export const IMAGE_MOUNTER_SERVICE = "com.apple.mobile.mobile_image_mounter.shim.remote";

/** 设备报告的已挂载镜像类型，例如 `["Personalized"]`；空数组是正常答案。 */
export async function mountedImageTypes(link: DdiLink): Promise<string[]> {
  if (!link.hasService(IMAGE_MOUNTER_SERVICE)) {
    throw new Error(`设备没有提供 ${IMAGE_MOUNTER_SERVICE}`);
  }

  return link.withService(IMAGE_MOUNTER_SERVICE, async (client) => {
    const reply = await client.request({ Command: "CopyDevices" });
    const entries = reply.EntryList;
    if (!Array.isArray(entries)) return [];
    return entries.map(imageTypeOf).filter((type) => type.length > 0);
  });
}

/** 条目的类型：mounter 回 `DiskImageType`，有时拼成 `ImageType`。 */
function imageTypeOf(entry: unknown): string {
  if (!isPlistDict(entry)) return "";
  const type = entry.DiskImageType ?? entry.ImageType;
  return typeof type === "string" ? type : "";
}
