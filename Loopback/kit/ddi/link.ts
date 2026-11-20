// DDI 只依赖这些会话能力，不直接依赖 DeviceSession；单测可以给一个轻量 mock。

import type { ByteStream } from "../../core/stream";
import type { PlistServiceClient } from "../lockdown";

export interface DdiLink {
  hasService(name: string): boolean;
  withService<T>(name: string, use: (client: PlistServiceClient) => Promise<T>): Promise<T>;
  withRawService<T>(name: string, use: (stream: ByteStream) => Promise<T>): Promise<T>;
  refreshServices(): Promise<void>;
}
