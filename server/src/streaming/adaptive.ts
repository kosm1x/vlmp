export interface TranscodeProfile {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  maxRate: string;
  bufSize: string;
}

const PROFILES: TranscodeProfile[] = [
  {
    name: "1080p",
    width: 1920,
    height: 1080,
    videoBitrate: "5000k",
    audioBitrate: "192k",
    maxRate: "5500k",
    bufSize: "10000k",
  },
  {
    name: "720p",
    width: 1280,
    height: 720,
    videoBitrate: "2800k",
    audioBitrate: "128k",
    maxRate: "3200k",
    bufSize: "5600k",
  },
  {
    name: "480p",
    width: 854,
    height: 480,
    videoBitrate: "1400k",
    audioBitrate: "128k",
    maxRate: "1600k",
    bufSize: "2800k",
  },
  {
    name: "360p",
    width: 640,
    height: 360,
    videoBitrate: "800k",
    audioBitrate: "96k",
    maxRate: "1000k",
    bufSize: "1600k",
  },
];

export function getAvailableProfiles(
  sourceWidth: number | null,
  sourceHeight: number | null,
): TranscodeProfile[] {
  if (!sourceWidth || !sourceHeight)
    return PROFILES.filter((p) => p.height <= 720);
  return PROFILES.filter((p) => p.height <= sourceHeight);
}

// The variant playlist is synthesized from the probed media duration instead
// of serving ffmpeg's own growing playlist: a paced encoder (v0.1.4) only
// ever has a couple minutes written, so the real playlist made players show
// a creeping fake duration and blocked seeking past the encode frontier.
// Listing every segment up front (VOD) gives the player the true timeline;
// segments that don't exist yet are produced on demand by the segment
// route's wait/restart path. Segment boundaries are exact SEGMENT_SECONDS
// cuts (-force_key_frames in the transcoder), so EXTINF matches reality.
// Single source of truth for "the last segment the playlist lists" — the
// segment route uses the SAME boundary to reject requests past the end
// instead of spawning ffmpeg on a seek beyond the real stream.
export function maxSegmentIndex(
  durationSeconds: number,
  segmentSeconds: number,
): number {
  const safeEnd = durationSeconds * 0.998 - 0.5;
  return Math.max(0, Math.floor(safeEnd / segmentSeconds));
}

export function generateVariantPlaylist(
  durationSeconds: number,
  segmentSeconds: number,
): string {
  // Never advertise a segment the encoder may not produce — a 404 on a
  // listed tail segment is a fatal player error at the end of EVERY affected
  // file. Two overshoot sources: container metadata overstating the real
  // stream (VBR/mislabeled files), and keyframe drift (-force_key_frames
  // lands on the first frame ≥ the boundary, so 23.976fps segments run
  // 6.006s and segment i actually STARTS at i*6.006 — ~1 fewer segment per
  // hour than duration/6). A segment exists iff its real start precedes the
  // real end of stream, so list segment i only when i*seg < duration shaved
  // by 0.2% (covers NTSC drift) minus 0.5s (metadata slop). A too-short
  // final segment is harmless — the player ends cleanly at the buffer end —
  // only a MISSING listed segment is fatal.
  const count = maxSegmentIndex(durationSeconds, segmentSeconds) + 1;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:4",
    `#EXT-X-TARGETDURATION:${segmentSeconds}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (let i = 0; i < count; i++) {
    // Last EXTINF = true remainder (clamped to a full segment) so the bar's
    // total matches the media on short clips instead of rounding up to a
    // whole segment.
    const len =
      i === count - 1
        ? Math.min(
            segmentSeconds,
            Math.max(0.001, durationSeconds - segmentSeconds * (count - 1)),
          )
        : segmentSeconds;
    lines.push(`#EXTINF:${len.toFixed(6)},`);
    lines.push(`segment_${String(i).padStart(4, "0")}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

export function generateMasterPlaylist(profiles: TranscodeProfile[]): string {
  let m3u8 = "#EXTM3U\n";
  for (const profile of profiles) {
    const bandwidth =
      (parseInt(profile.videoBitrate, 10) +
        parseInt(profile.audioBitrate, 10)) *
      1000;
    m3u8 += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${profile.width}x${profile.height},NAME="${profile.name}"\n`;
    // Relative URI: resolves against whatever URL served this master —
    // /stream/:sid/ locally, /federation/servers/:id/stream/:sid/ when proxied.
    m3u8 += `${profile.name}/playlist.m3u8\n`;
  }
  return m3u8;
}
