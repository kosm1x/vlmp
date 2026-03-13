import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
  useRef,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { post, put, get, del, getToken } from "../api.js";
const html = htm.bind(h);

function fmt(s) {
  if (!s || isNaN(s)) return "0:00";
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function Player({ mediaId, onClose }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const progressTimer = useRef(null);
  const [session, setSession] = useState(null);
  const [media, setMedia] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [audioTracks, setAudioTracks] = useState([]);
  const [subtitles, setSubtitles] = useState([]);
  const [activeSubtitle, setActiveSubtitle] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const [mediaData, progress] = await Promise.all([
          get(`/library/${mediaId}`),
          get(`/progress/${mediaId}`).catch(() => ({ position_seconds: 0 })),
        ]);
        if (cancelled) return;
        setMedia(mediaData);
        const sd = await post(`/stream/${mediaId}/start`, {
          start_time: progress.position_seconds || 0,
        });
        if (cancelled) return;
        setSession(sd);
        setAudioTracks(sd.audio_tracks || []);
        // Fetch subtitles
        const subs = await get(`/subtitles/${mediaId}`).catch(() => []);
        if (!cancelled) setSubtitles(subs || []);
        const video = videoRef.current;
        if (!video) return;
        if (sd.mode === "direct") {
          video.src = sd.url;
          if (progress.position_seconds > 0)
            video.currentTime = progress.position_seconds;
        } else if (window.Hls && Hls.isSupported()) {
          const hls = new Hls({
            startPosition: progress.position_seconds || 0,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
          });
          hls.loadSource(sd.url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
            video.play().catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (_, d) => {
            if (d.fatal) setError("Playback error");
          });
          hlsRef.current = hls;
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = sd.url;
          if (progress.position_seconds > 0)
            video.currentTime = progress.position_seconds;
        }
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    }
    init();
    return () => {
      cancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [mediaId]);

  useEffect(() => {
    progressTimer.current = setInterval(() => {
      const v = videoRef.current;
      if (v && v.currentTime > 0)
        put(`/progress/${mediaId}`, {
          position_seconds: v.currentTime,
          duration_seconds: v.duration || 0,
        }).catch(() => {});
    }, 10000);
    return () => clearInterval(progressTimer.current);
  }, [mediaId]);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (v) {
      setCurrentTime(v.currentTime);
      setDuration(v.duration || 0);
    }
  }
  function togglePlay() {
    const v = videoRef.current;
    if (v) v.paused ? v.play() : v.pause();
  }
  function seek(e) {
    const v = videoRef.current;
    if (v) v.currentTime = parseFloat(e.target.value);
  }
  function changeVol(e) {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) videoRef.current.volume = val;
  }
  function toggleMute() {
    setMuted(!muted);
    if (videoRef.current) videoRef.current.muted = !muted;
  }
  function changeSpeed(e) {
    const s = parseFloat(e.target.value);
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }
  function toggleFs() {
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
  }
  function restart() {
    const v = videoRef.current;
    if (v) {
      v.currentTime = 0;
      v.play();
    }
  }
  function handleClose() {
    const v = videoRef.current;
    if (v && v.currentTime > 0)
      put(`/progress/${mediaId}`, {
        position_seconds: v.currentTime,
        duration_seconds: v.duration || 0,
      }).catch(() => {});
    if (session) del(`/stream/${session.session_id}`).catch(() => {});
    onClose();
  }

  if (error)
    return html`<div class="player-page">
      <div
        style=${{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div style=${{ color: "#e50914" }}>${error}</div>
        <button class="player-btn" onClick=${handleClose}>Back</button>
      </div>
    </div>`;

  return html`<div class="player-page">
    <div class="player-header">
      <button class="player-back" onClick=${handleClose}>←</button
      ><span class="player-title">${media?.title || "Loading..."}</span>
    </div>
    <video
      ref=${videoRef}
      class="player-video"
      onTimeUpdate=${onTimeUpdate}
      onPlay=${() => setPlaying(true)}
      onPause=${() => setPlaying(false)}
      onEnded=${() => {
        setPlaying(false);
        put("/progress/" + mediaId, {
          position_seconds: duration,
          duration_seconds: duration,
        }).catch(() => {});
      }}
      onClick=${togglePlay}
      autoplay
      crossorigin="anonymous"
    >
      ${subtitles.map(
        (s) =>
          html`<track
            kind="subtitles"
            src=${`/subtitles/${mediaId}/${s.id}/file?token=${encodeURIComponent(getToken())}`}
            srclang=${s.language || "und"}
            label=${s.label || s.language || "Unknown"}
          />`,
      )}
    </video>
    ${loading &&
    html`<div class="loading" style=${{ position: "absolute", inset: 0 }}>
      Loading...
    </div>`}
    <div class="player-controls">
      <input
        class="player-seek"
        type="range"
        min="0"
        max=${duration || 0}
        step="0.1"
        value=${currentTime}
        onInput=${seek}
      />
      <div class="player-buttons">
        <button class="player-btn" onClick=${togglePlay}>
          ${playing ? "\u23F8" : "\u25B6"}
        </button>
        <button
          class="player-btn"
          onClick=${restart}
          title="Start from beginning"
        >
          ⏮
        </button>
        <button class="player-btn" onClick=${toggleMute}>
          ${muted ? "\uD83D\uDD07" : "\uD83D\uDD0A"}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value=${volume}
          onInput=${changeVol}
          style=${{ width: "80px", accentColor: "#e50914" }}
        />
        <span class="player-time">${fmt(currentTime)} / ${fmt(duration)}</span>
        <div class="player-spacer"></div>
        <select class="player-select" value=${speed} onChange=${changeSpeed}>
          <option value="0.5">0.5x</option>
          <option value="0.75">0.75x</option>
          <option value="1">1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>
        ${audioTracks.length > 1 &&
        html`<select class="player-select">
          ${audioTracks.map(
            (t, i) =>
              html`<option value=${i}>
                ${t.language || "Track " + (i + 1)} (${t.codec})
              </option>`,
          )}
        </select>`}
        ${subtitles.length > 0 &&
        html`<select
          class="player-select"
          value=${activeSubtitle || ""}
          onChange=${(e) => {
            const val = e.target.value;
            setActiveSubtitle(val || null);
            const video = videoRef.current;
            if (video) {
              for (let i = 0; i < video.textTracks.length; i++) {
                video.textTracks[i].mode =
                  video.textTracks[i].language === val ? "showing" : "hidden";
              }
            }
          }}
        >
          <option value="">Subs Off</option>
          ${subtitles.map(
            (s) =>
              html`<option value=${s.language || "und"}>
                ${s.label || s.language || "Unknown"}
              </option>`,
          )}
        </select>`}
        <button class="player-btn" onClick=${toggleFs}>⛶</button>
      </div>
    </div>
  </div>`;
}
