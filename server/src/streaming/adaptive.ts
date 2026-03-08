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
  { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', maxRate: '5500k', bufSize: '10000k' },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: '2800k', audioBitrate: '128k', maxRate: '3200k', bufSize: '5600k' },
  { name: '480p',  width: 854,  height: 480,  videoBitrate: '1400k', audioBitrate: '128k', maxRate: '1600k', bufSize: '2800k' },
  { name: '360p',  width: 640,  height: 360,  videoBitrate: '800k',  audioBitrate: '96k',  maxRate: '1000k', bufSize: '1600k' },
];

export function getAvailableProfiles(sourceWidth: number | null, sourceHeight: number | null): TranscodeProfile[] {
  if (!sourceWidth || !sourceHeight) return PROFILES.filter(p => p.height <= 720);
  return PROFILES.filter(p => p.height <= sourceHeight);
}

export function selectInitialProfile(profiles: TranscodeProfile[], estimatedBandwidthKbps: number | null): TranscodeProfile {
  if (!estimatedBandwidthKbps || profiles.length === 0) return profiles[profiles.length - 1] || PROFILES[PROFILES.length - 1];
  const effectiveBw = estimatedBandwidthKbps * 0.8;
  for (const profile of profiles) {
    const bitrate = parseInt(profile.videoBitrate, 10) + parseInt(profile.audioBitrate, 10);
    if (bitrate <= effectiveBw) return profile;
  }
  return profiles[profiles.length - 1];
}

export function generateMasterPlaylist(profiles: TranscodeProfile[], sessionId: string): string {
  let m3u8 = '#EXTM3U\n';
  for (const profile of profiles) {
    const bandwidth = (parseInt(profile.videoBitrate, 10) + parseInt(profile.audioBitrate, 10)) * 1000;
    m3u8 += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${profile.width}x${profile.height},NAME="${profile.name}"\n`;
    m3u8 += `/stream/${sessionId}/${profile.name}/playlist.m3u8\n`;
  }
  return m3u8;
}
