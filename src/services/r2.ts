import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

const client = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY,
    secretAccessKey: env.R2_SECRET_KEY,
  },
});

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function deleteObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}

// 객체로 묶어서 내보낸다 — ESM named export는 바깥에서 교체할 수 없어서, 테스트가 실제 R2를 호출하지
// 않도록 mock.method(storage, ...)로 바꿔 끼우려면 호출부가 항상 storage.xxx()로 불러야 한다.
export const storage = { putObject, deleteObject };

export function publicUrlFor(key: string): string {
  return `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}
