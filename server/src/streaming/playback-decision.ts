import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { probeFile } from "../scanner/probe.js";
import { canDirectPlay, isBrowserSafePixFmt } from "./direct.js";

// The codec fields the direct-vs-transcode decision needs. Both getMediaById
// helpers return `SELECT *`, so a full media row satisfies this.
export interface PlaybackMedia {
  id: number;
  file_path: string;
  codec_video: string | null;
  codec_audio: string | null;
  pix_fmt: string | null;
  probed_at: number | null;
  resolution_width: number | null;
  resolution_height: number | null;
  duration: number | null;
}

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

// Decide whether a file can be served as-is (direct play) or must be
// transcoded. Codec metadata can be missing — a folder scanned before ffprobe
// was available stores NULL, and canDirectPlay then fails OPEN, serving an
// undecodable file as direct play which the browser silently aborts. So the
// FIRST time we play a never-probed row (probed_at IS NULL) we probe now and
// persist the result (codecs, pix_fmt, dims, duration), then decide from the
// truth — direct requires a browser-safe codec AND ≤8-bit pixel format. If
// ffprobe is unavailable the probe is caught and we fall back to the old
// optimistic guess (no worse than before). Shared by the library, guest, and
// federation start routes so all three get the same, correct decision.
export async function resolvePlayback(
  db: Database.Database,
  media: PlaybackMedia,
  ext: string,
  config: Config,
  log: Logger,
): Promise<{ direct: boolean; width: number | null; height: number | null }> {
  let codecVideo = media.codec_video;
  let codecAudio = media.codec_audio;
  let pixFmt = media.pix_fmt;
  let width = media.resolution_width;
  let height = media.resolution_height;

  if (media.probed_at == null) {
    const probe = await probeFile(media.file_path, config).catch(
      (err: unknown) => {
        log.warn(
          { err, mediaId: media.id },
          "playback re-probe failed — is ffprobe installed?",
        );
        return null;
      },
    );
    if (probe) {
      codecVideo = probe.codecVideo;
      codecAudio = probe.codecAudio;
      pixFmt = probe.pixFmt;
      width = probe.width ?? width;
      height = probe.height ?? height;
      db.prepare(
        "UPDATE media_items SET codec_video = ?, codec_audio = ?, pix_fmt = ?, resolution_width = COALESCE(?, resolution_width), resolution_height = COALESCE(?, resolution_height), duration = COALESCE(?, duration), probed_at = unixepoch() WHERE id = ?",
      ).run(
        codecVideo,
        codecAudio,
        pixFmt,
        probe.width,
        probe.height,
        probe.duration || null,
        media.id,
      );
    }
  }

  const direct =
    canDirectPlay(codecVideo, codecAudio, ext) && isBrowserSafePixFmt(pixFmt);
  log.info(
    { mediaId: media.id, codecVideo, codecAudio, pixFmt, ext, direct },
    "playback mode decided",
  );
  return { direct, width, height };
}
