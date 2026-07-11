/**
 * Attachment loading for the `say` tool — resolves working-tree file paths
 * into base64 channel attachments (see ChannelAttachment in channel-client.ts).
 * Image-only for now: the chat panel renders message attachments through its
 * image gallery, so accepting other types would silently show nothing.
 */
import {
    SUPPORTED_IMAGE_TYPES,
    uint8ArrayToBase64,
    validateAttachments,
} from "@workspace/pubsub";
import type { ChannelAttachment } from "./channel-client.js";

/** The one fs capability the loader needs (satisfied by createRpcFs). */
interface AttachmentFs {
    readFile(path: string): Promise<string | Uint8Array>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
};

export function inferAttachmentMimeType(path: string): string {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mimeType = path.includes(".") ? MIME_BY_EXTENSION[extension] : undefined;
    if (!mimeType) {
        throw new Error(
            `say attachment "${path}": unsupported file type — attachments must be images (${SUPPORTED_IMAGE_TYPES.join(", ")})`
        );
    }
    return mimeType;
}

export async function readSayAttachments(
    fs: AttachmentFs,
    paths: string[]
): Promise<Array<Required<Pick<ChannelAttachment, "id" | "data" | "mimeType" | "size">> & { name: string }>> {
    const loaded = await Promise.all(
        paths.map(async (path, index) => {
            const mimeType = inferAttachmentMimeType(path);
            let contents: string | Uint8Array;
            try {
                contents = await fs.readFile(path);
            } catch (error) {
                throw new Error(
                    `say attachment "${path}": ${error instanceof Error ? error.message : String(error)}`
                );
            }
            if (typeof contents === "string") {
                throw new Error(`say attachment "${path}": expected binary image data, got text`);
            }
            const name = path.split("/").filter(Boolean).pop() ?? path;
            return { id: `att_${index}`, bytes: contents, mimeType, name };
        })
    );
    const validation = validateAttachments(
        loaded.map((attachment) => ({
            id: attachment.id,
            data: attachment.bytes,
            mimeType: attachment.mimeType,
            name: attachment.name,
        }))
    );
    if (!validation.valid) throw new Error(`say attachments: ${validation.error}`);
    return loaded.map((attachment) => ({
        id: attachment.id,
        data: uint8ArrayToBase64(attachment.bytes),
        mimeType: attachment.mimeType,
        name: attachment.name,
        size: attachment.bytes.length,
    }));
}
