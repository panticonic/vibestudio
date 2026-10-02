import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { StreamResponseSchema } from "@vibestudio/shared/streamResponse";

// Base64 plus RPC metadata must fit the smallest transport's 8 MiB envelope.
export const SPEECH_MAX_PCM_BYTES = 4 * 1024 * 1024;
export const speechRecordingSchema = z.object({
  format: z.literal("pcm_f32le"),
  sampleRate: z.literal(16000),
  audio: z.string().max(Math.ceil(SPEECH_MAX_PCM_BYTES / 3) * 4),
});
export type SpeechRecording = z.infer<typeof speechRecordingSchema>;
export type SpeechEvent =
  | { type: "progress"; message: string }
  | { type: "result"; text: string; model: "phonon-2"; language: "en" };

export const speechMethods = defineServiceMethods({
  transcribe: {
    description:
      "Transcribe supplied mono audio locally using the bundled English Phonon-2 model. Returns an NDJSON progress/result stream.",
    args: z.tuple([speechRecordingSchema]),
    argumentNames: ["recording"],
    returns: StreamResponseSchema,
    access: { sensitivity: "read" },
    website: {
      kind: "eligible",
      rationale:
        "Transforms only audio supplied by the caller. Microphone capture requires its own device permission.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "speech.transcribe",
      rationale:
        "Installed CPU inference over caller-supplied bytes; no workspace or host data is disclosed and no microphone is accessed by this operation.",
    },
  },
});
