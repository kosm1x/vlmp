import { createReadStream, statSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

const DIRECT_PLAY_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const DIRECT_PLAY_AUDIO_CODECS = new Set([
  "aac",
  "mp3",
  "opus",
  "vorbis",
  "flac",
]);

export function canDirectPlay(
  codecVideo: string | null,
  codecAudio: string | null,
  ext: string,
): boolean {
  if (!codecVideo && codecAudio)
    return DIRECT_PLAY_AUDIO_CODECS.has(codecAudio);
  const containerOk = ext === ".mp4" || ext === ".webm" || ext === ".m4v";
  const videoOk = codecVideo ? DIRECT_PLAY_VIDEO_CODECS.has(codecVideo) : true;
  const audioOk = codecAudio ? DIRECT_PLAY_AUDIO_CODECS.has(codecAudio) : true;
  return containerOk && videoOk && audioOk;
}

export function serveDirectFile(
  filePath: string,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const stat = statSync(filePath);
  const fileSize = stat.size;
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const range = request.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (
      isNaN(start) ||
      start < 0 ||
      start >= fileSize ||
      end < start ||
      end >= fileSize
    ) {
      reply.code(416).header("Content-Range", `bytes */${fileSize}`).send();
      return;
    }
    const chunkSize = end - start + 1;
    const stream = createReadStream(filePath, { start, end });
    reply
      .code(206)
      .header("Content-Range", `bytes ${start}-${end}/${fileSize}`)
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", chunkSize)
      .header("Content-Type", contentType)
      .send(stream);
  } else {
    const stream = createReadStream(filePath);
    reply
      .header("Content-Length", fileSize)
      .header("Content-Type", contentType)
      .header("Accept-Ranges", "bytes")
      .send(stream);
  }
}
