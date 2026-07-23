import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { post, put, get, del } from "../api.js";
import { navigate } from "../router.js";
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

export function Player({
  mediaId,
  onClose,
  serverId,
  federated,
  show,
  playlist,
  index,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const progressTimer = useRef(null);
  const keepaliveTimer = useRef(null);
  const lastUiUpdate = useRef(0);
  // The full "/play/..." href of the next item in the series/playlist this
  // player was opened from (null at the end), so a finished item auto-advances
  // and playback continues until the queue runs out or the user leaves. It is a
  // ready-made href (not just an id) so the queue context — and, for playlists,
  // the exact position — survive the navigation.
  const [nextHref, setNextHref] = useState(null);
  function goNext() {
    // replace: the player stays a single history entry, so Back exits instead
    // of stepping back through every auto-advanced item.
    if (nextHref) navigate(nextHref, true);
  }
  // The stream timeline is absolute media time for BOTH direct play and HLS:
  // the server synthesizes a full VOD playlist from the real duration, so
  // resume is a plain seek and the bar needs no offset arithmetic.
  const sessionRef = useRef(null);
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
    // Auto-advance UPDATES this player in place (mediaId prop changes), so clear
    // every per-item field first — otherwise the previous episode's title, seek
    // bar, and subtitle list flash until the new data lands.
    setMedia(null);
    setSubtitles([]);
    setActiveSubtitle(null);
    setAudioTracks([]);
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    setError("");
    setLoading(true);
    async function init() {
      try {
        let mediaData, progress;
        if (federated) {
          [mediaData, progress] = await Promise.all([
            get(`/federation/servers/${serverId}/media/${mediaId}`),
            Promise.resolve({ position_seconds: 0 }),
          ]);
        } else {
          [mediaData, progress] = await Promise.all([
            get(`/library/${mediaId}`),
            get(`/progress/${mediaId}`).catch(() => ({ position_seconds: 0 })),
          ]);
        }
        if (cancelled) return;
        setMedia(mediaData);
        const streamUrl = federated
          ? `/federation/servers/${serverId}/stream/${mediaId}/start`
          : `/stream/${mediaId}/start`;
        const sd = await post(streamUrl, {});
        if (cancelled) {
          // Navigated away while the session was starting: the effect cleanup
          // already ran (sessionRef was still null), so tear down the session
          // we just created rather than leaving it for the idle reaper.
          const stopUrl = federated
            ? `/federation/servers/${serverId}/stream/${sd.session_id}`
            : `/stream/${sd.session_id}`;
          del(stopUrl).catch(() => {});
          return;
        }
        sessionRef.current = sd;
        setAudioTracks(sd.audio_tracks || []);
        // Fetch subtitles with HMAC tokens (local only)
        if (!federated) {
          const subs = await get(`/subtitles/${mediaId}`).catch(() => []);
          if (!cancelled && subs && subs.length > 0) {
            const subsWithTokens = await Promise.all(
              subs.map(async (s) => {
                const { token } = await get(
                  `/subtitles/${mediaId}/${s.id}/token`,
                ).catch(() => ({ token: null }));
                return { ...s, hmacToken: token };
              }),
            );
            if (!cancelled) setSubtitles(subsWithTokens);
          }
        }
        const video = videoRef.current;
        if (!video) return;
        const resumeAt = progress.position_seconds || 0;
        // currentTime set before the media is seekable is silently dropped
        // by Safari (and racy elsewhere) — apply the resume seek once
        // metadata is in for the non-hls.js paths.
        const seekOnReady = () => {
          if (resumeAt > 0 && Math.abs(video.currentTime - resumeAt) > 1)
            video.currentTime = resumeAt;
        };
        if (sd.mode === "direct") {
          video.addEventListener("loadedmetadata", seekOnReady, {
            once: true,
          });
          video.src = sd.url;
        } else if (window.Hls && Hls.isSupported()) {
          const hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            // Segments are transcoded on demand, so a freshly-sought fragment
            // can 404 for a few seconds while ffmpeg catches up. Give it a
            // generous retry budget so a transient not-ready never becomes a
            // fatal error.
            fragLoadingMaxRetry: 8,
            fragLoadingRetryDelay: 1000,
            fragLoadingMaxRetryTimeout: 30000,
          });
          hls.loadSource(sd.url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
            // Resume = seek on the absolute VOD timeline; the server spawns
            // the encoder at whatever segment this lands on.
            if (resumeAt > 0) video.currentTime = resumeAt;
            video.play().catch(() => {});
          });
          // Only give up after recovery fails: once hls.js exhausts its own
          // fragment retries it fires a FATAL error, but for on-demand
          // transcoding that usually just means "encoder still catching up".
          // Resume loading (network) or rebuild the buffer (media) a few times
          // before surfacing a permanent error; a clean fragment resets the
          // budget so only a sustained failure stops playback.
          let recoveries = 0;
          hls.on(Hls.Events.FRAG_BUFFERED, () => {
            recoveries = 0;
          });
          hls.on(Hls.Events.ERROR, (_, d) => {
            if (!d.fatal) return;
            if (recoveries >= 4) {
              setError("Playback error");
              return;
            }
            recoveries++;
            if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            else hls.startLoad();
          });
          hlsRef.current = hls;
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Native HLS (Safari): same absolute timeline.
          video.addEventListener("loadedmetadata", seekOnReady, {
            once: true,
          });
          video.src = sd.url;
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
      // Tear down the server session on ANY unmount path (hash navigation,
      // component swap) — otherwise its ffmpeg jobs run for 10 idle minutes.
      endSession();
    };
  }, [mediaId]);

  // Resolve the next item's href in the show/playlist this player was opened
  // from. Playlists carry the current position (`index`) so a title that
  // appears twice advances from the copy you actually played, not the first.
  useEffect(() => {
    let cancelled = false;
    setNextHref(null);
    if (federated || (!show && !playlist)) return;
    (async () => {
      try {
        if (playlist) {
          const pl = await get(`/playlists/${playlist}`);
          const items = pl.items || [];
          const cur =
            index != null && index !== ""
              ? Number(index)
              : items.findIndex((it) => it.media_id === Number(mediaId));
          const nxt = cur >= 0 ? items[cur + 1] : undefined;
          if (!cancelled)
            setNextHref(
              nxt
                ? `/play/${nxt.media_id}?playlist=${playlist}&i=${cur + 1}`
                : null,
            );
        } else {
          const d = await get(`/library/shows/${show}`);
          const ids = (d.seasons || []).flatMap((s) =>
            (s.episodes || []).map((e) => e.media_id),
          );
          const idx = ids.indexOf(Number(mediaId));
          const nxt = idx >= 0 && idx + 1 < ids.length ? ids[idx + 1] : null;
          if (!cancelled)
            setNextHref(nxt != null ? `/play/${nxt}?show=${show}` : null);
        }
      } catch {
        /* no queue context reachable — stay single-play */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaId, show, playlist, index, federated]);

  function saveProgress(fetchOptions) {
    if (federated) return;
    // No session yet = still initializing; the <video> element may hold the
    // PREVIOUS title's currentTime, and the offset isn't assigned yet.
    if (!sessionRef.current) return;
    const v = videoRef.current;
    if (!v || !(v.currentTime > 0)) return;
    put(
      `/progress/${mediaId}`,
      {
        position_seconds: v.currentTime,
        duration_seconds: v.duration || 0,
      },
      fetchOptions,
    ).catch(() => {});
  }

  function endSession(fetchOptions) {
    const sd = sessionRef.current;
    if (!sd) return;
    sessionRef.current = null;
    const stopUrl = federated
      ? `/federation/servers/${serverId}/stream/${sd.session_id}`
      : `/stream/${sd.session_id}`;
    del(stopUrl, fetchOptions).catch(() => {});
  }

  useEffect(() => {
    // VOD playlists are fetched once and a paused player requests nothing —
    // ping the session so the idle sweep spares it (proxied to the remote
    // server for federated playback).
    keepaliveTimer.current = setInterval(() => {
      const sd = sessionRef.current;
      if (!sd) return;
      const kaUrl = federated
        ? `/federation/servers/${serverId}/stream/${sd.session_id}/keepalive`
        : `/stream/${sd.session_id}/keepalive`;
      post(kaUrl, {}).catch(() => {});
    }, 240000);
    if (federated) return () => clearInterval(keepaliveTimer.current);
    progressTimer.current = setInterval(() => saveProgress(), 10000);
    return () => {
      clearInterval(progressTimer.current);
      clearInterval(keepaliveTimer.current);
    };
  }, [mediaId, federated]);

  // Refresh/tab-close never runs unmount cleanup — flush progress and free the
  // server's ffmpeg jobs with keepalive fetches that outlive the page.
  useEffect(() => {
    const onPageHide = () => {
      saveProgress({ keepalive: true });
      endSession({ keepalive: true });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [mediaId, federated]);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    const now = Date.now();
    if (now - lastUiUpdate.current < 1000) return;
    lastUiUpdate.current = now;
    setCurrentTime(v.currentTime);
    const d = v.duration || 0;
    if (d !== duration) setDuration(d);
  }
  function togglePlay() {
    const v = videoRef.current;
    if (v) v.paused ? v.play() : v.pause();
  }
  function seek(e) {
    const v = videoRef.current;
    // Bar and stream share the same absolute timeline — seek is direct.
    if (v) v.currentTime = Math.max(0, parseFloat(e.target.value));
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
    saveProgress();
    endSession();
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
        if (!federated)
          put("/progress/" + mediaId, {
            position_seconds: duration,
            duration_seconds: duration,
          }).catch(() => {});
        // Continuous playback: roll on to the next episode / playlist item
        // until the queue is empty or the user leaves.
        goNext();
      }}
      onClick=${togglePlay}
      onError=${() => {
        const v = videoRef.current;
        // hls.js owns error handling for the transcode path (see its ERROR
        // handler). Only surface DIRECT-play failures here — a decode /
        // unsupported-source error means the browser can't play this file's
        // codec, which otherwise fails silently ("stream closed prematurely"
        // server-side, blank player client-side).
        if (
          sessionRef.current?.mode === "direct" &&
          v?.error &&
          (v.error.code === 3 || v.error.code === 4)
        )
          setError(
            "This video's format can't be played in the browser. It needs transcoding — make sure FFmpeg is installed on the server, then try again.",
          );
      }}
      autoplay
      crossorigin="anonymous"
    >
      ${subtitles.map(
        (s) =>
          s.hmacToken &&
          html`<track
            kind="subtitles"
            src=${`/subtitles/${mediaId}/${s.id}/file?token=${encodeURIComponent(s.hmacToken)}`}
            srclang=${s.language || "und"}
            label=${s.label || s.language || "Unknown"}
          />`,
      )}
    </video>
    ${
      loading &&
      html`<div class="loading" style=${{ position: "absolute", inset: 0 }}>
        Loading...
      </div>`
    }
    <div class="player-controls">
      <input
        class="player-seek"
        type="range"
        min="0"
        max=${duration || 0}
        step="0.1"
        value=${currentTime}
        onInput=${seek}
        aria-label="Seek"
      />
      <div class="player-buttons">
        <button
          class="player-btn"
          onClick=${togglePlay}
          aria-label=${playing ? "Pause" : "Play"}
        >
          ${playing ? "\u23F8" : "\u25B6"}
        </button>
        <button
          class="player-btn"
          onClick=${restart}
          title="Start from beginning"
          aria-label="Restart from beginning"
        >
          ⏮
        </button>
        ${
          nextHref &&
          html`<button
            class="player-btn"
            onClick=${goNext}
            title="Next"
            aria-label="Play next"
          >
            ⏭
          </button>`
        }
        <button
          class="player-btn"
          onClick=${toggleMute}
          aria-label=${muted ? "Unmute" : "Mute"}
        >
          ${muted ? "\uD83D\uDD07" : "\uD83D\uDD0A"}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value=${volume}
          onInput=${changeVol}
          aria-label="Volume"
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
        ${
          audioTracks.length > 1 &&
          html`<select class="player-select">
            ${audioTracks.map(
              (t, i) =>
                html`<option value=${i}>
                  ${t.language || "Track " + (i + 1)} (${t.codec})
                </option>`,
            )}
          </select>`
        }
        ${
          subtitles.length > 0 &&
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
          </select>`
        }
        <button
          class="player-btn"
          onClick=${toggleFs}
          aria-label="Toggle fullscreen"
        >
          ⛶
        </button>
      </div>
    </div>
  </div>`;
}
