import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/server/db";
import { auditLogs, user as users } from "@/server/db/schema";
import { getObjectStorage } from "@/server/providers";
import type { ObjectStorage } from "@/server/providers/types";
import { asUserActor, authenticate, auditContext } from "@/server/api/auth";
import {
  ApiError,
  jsonData,
  notFound,
  withApiErrors
} from "@/server/api/errors";
import type { AuditContext, AuthenticatedUser } from "@/server/api/types";

import { accountAvatarObjectKey } from "./avatar-key";

export { accountAvatarObjectKey } from "./avatar-key";

const AVATAR_ENDPOINT = "/api/account/avatar";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_PIXELS = 16_777_216;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);

export type StoredAvatar = {
  objectKey: string;
  revision: number;
};

export interface AvatarRepository {
  get(userId: string): Promise<StoredAvatar | null>;
  set(
    userId: string,
    objectKey: string,
    audit: AuditContext
  ): Promise<StoredAvatar | null>;
  clear(userId: string, audit: AuditContext): Promise<boolean>;
}

export const avatarRepository: AvatarRepository = {
  async get(userId) {
    const [row] = await db
      .select({
        objectKey: users.avatarObjectKey,
        revision: users.avatarRevision
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.objectKey) return null;
    return { objectKey: row.objectKey, revision: row.revision };
  },

  async set(userId, objectKey, audit) {
    return db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({
          id: users.id,
          avatarObjectKey: users.avatarObjectKey,
          avatarRevision: users.avatarRevision
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!existing) return null;

      const [updated] = await transaction
        .update(users)
        .set({
          avatarObjectKey: objectKey,
          avatarRevision: sql`${users.avatarRevision} + 1`,
          image: AVATAR_ENDPOINT,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId))
        .returning({
          objectKey: users.avatarObjectKey,
          revision: users.avatarRevision
        });
      if (!updated?.objectKey) return null;

      await transaction.insert(auditLogs).values({
        actorUserId: audit.actor.id,
        actorRole: "user",
        action: "account.avatar.update",
        targetType: "user",
        targetId: userId,
        requestId: audit.requestId,
        before: {
          configured: Boolean(existing.avatarObjectKey),
          revision: existing.avatarRevision
        },
        after: { configured: true, revision: updated.revision },
        metadata: {}
      });
      return { objectKey: updated.objectKey, revision: updated.revision };
    });
  },

  async clear(userId, audit) {
    return db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({
          id: users.id,
          configured: users.avatarObjectKey,
          revision: users.avatarRevision
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!existing) return false;

      await transaction
        .update(users)
        .set({
          avatarObjectKey: null,
          avatarRevision: sql`${users.avatarRevision} + 1`,
          image: null,
          updatedAt: new Date()
        })
        .where(eq(users.id, userId));
      await transaction.insert(auditLogs).values({
        actorUserId: audit.actor.id,
        actorRole: "user",
        action: "account.avatar.delete",
        targetType: "user",
        targetId: userId,
        requestId: audit.requestId,
        before: {
          configured: Boolean(existing.configured),
          revision: existing.revision
        },
        after: { configured: false, revision: existing.revision + 1 },
        metadata: {}
      });
      return true;
    });
  }
};

export async function processAvatarImage(
  input: Uint8Array
): Promise<Uint8Array> {
  let image: ReturnType<typeof sharp>;
  try {
    image = sharp(input, {
      failOn: "warning",
      limitInputPixels: MAX_AVATAR_PIXELS,
      animated: false
    });
    const metadata = await image.metadata();
    if (
      !metadata.format ||
      !ALLOWED_FORMATS.has(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_AVATAR_PIXELS ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error("unsupported avatar image");
    }
    return new Uint8Array(
      await image
        .rotate()
        .resize(256, 256, { fit: "cover", position: "centre" })
        .webp({ quality: 82, effort: 4 })
        .toBuffer()
    );
  } catch (cause) {
    throw new ApiError(
      422,
      "INVALID_AVATAR_IMAGE",
      "头像无法安全解码，请使用有效的 JPG、PNG 或 WebP 图片。",
      cause
    );
  }
}

type AuthenticateRequest = (request: Request) => Promise<AuthenticatedUser>;

export const handleGetAccountAvatar = withApiErrors(
  async (
    request: Request,
    repository: AvatarRepository = avatarRepository,
    storage: ObjectStorage = getObjectStorage(),
    authenticateRequest: AuthenticateRequest = authenticate
  ) => {
    const user = await authenticateRequest(request);
    const avatar = await repository.get(user.id);
    const expectedKey = accountAvatarObjectKey(user.id);
    if (!avatar || avatar.objectKey !== expectedKey) throw notFound("头像");
    const bytes = await storage.getPrivate(expectedKey);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new Response(body, {
      headers: {
        "content-type": "image/webp",
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff"
      }
    });
  }
);

export const handleUploadAccountAvatar = withApiErrors(
  async (
    request: Request,
    repository: AvatarRepository = avatarRepository,
    storage: ObjectStorage = getObjectStorage(),
    authenticateRequest: AuthenticateRequest = authenticate,
    processImage: (
      input: Uint8Array
    ) => Promise<Uint8Array> = processAvatarImage
  ) => {
    const user = await authenticateRequest(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(422, "AVATAR_FILE_REQUIRED", "请选择头像图片。");
    }
    if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
      throw new ApiError(
        415,
        "UNSUPPORTED_AVATAR_TYPE",
        "头像仅支持 JPG、PNG 或 WebP。"
      );
    }
    if (file.size < 1 || file.size > MAX_AVATAR_BYTES) {
      throw new ApiError(413, "AVATAR_TOO_LARGE", "头像文件不得超过 5 MB。");
    }

    const output = await processImage(new Uint8Array(await file.arrayBuffer()));
    const objectKey = accountAvatarObjectKey(user.id);
    await storage.putPrivate({
      key: objectKey,
      body: output,
      contentType: "image/webp",
      metadata: {
        purpose: "account-avatar",
        "pixel-size": "256x256"
      }
    });

    const audit = auditContext(request, asUserActor(user));
    try {
      const updated = await repository.set(user.id, objectKey, audit);
      if (!updated) {
        throw notFound("账户");
      }
      return jsonData({
        image: AVATAR_ENDPOINT,
        revision: updated.revision
      });
    } catch (cause) {
      // The key is stable per account. Deleting it here could erase a
      // previously configured avatar when only the database update failed.
      // A later upload, explicit delete, or account cleanup safely reuses it.
      throw cause;
    }
  }
);

export const handleDeleteAccountAvatar = withApiErrors(
  async (
    request: Request,
    repository: AvatarRepository = avatarRepository,
    storage: ObjectStorage = getObjectStorage(),
    authenticateRequest: AuthenticateRequest = authenticate
  ) => {
    const user = await authenticateRequest(request);
    const cleared = await repository.clear(
      user.id,
      auditContext(request, asUserActor(user))
    );
    if (!cleared) throw notFound("账户");
    await storage.deletePrivate(accountAvatarObjectKey(user.id));
    return jsonData({ image: null });
  }
);
