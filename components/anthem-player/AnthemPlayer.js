import { createEl } from '../../lib/domUtils.js';
import { isUnavailable, sourcesDiffer } from './anthemMeta.js';

// A true singleton: one real <audio> element, created once and appended outside both
// the side panel and country page DOM trees (in #anthem-player-root), so hash
// navigation between those views — which re-renders their containers — never touches
// it. Playback state (and the audio element itself) survives; only mountInto() moves
// which container the *visible* controls render into.

let audioEl = null;
let currentIso3 = null;
let currentMeta = null;
let mountedContainer = null;
let uiRefs = null;
let unavailable = true; // there is NO recording to play
let loadFailed = false; // there is one, but every file failed to load: Play tries again
const failedSources = new Set(); // the <source> elements the browser has given up on for the current recording

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

function formatLicense(license) {
  if (!license) return null;
  const credit = license.credit?.split('\n')[0]?.trim();
  return [license.shortName, credit].filter(Boolean).join(' · ');
}

function ensureAudioEl() {
  if (audioEl) return audioEl;
  audioEl = document.createElement('audio');
  audioEl.preload = 'none';
  audioEl.addEventListener('timeupdate', updateProgress);
  audioEl.addEventListener('loadedmetadata', updateProgress);
  audioEl.addEventListener('play', () => setPlayingUI(true));
  audioEl.addEventListener('pause', () => setPlayingUI(false));
  audioEl.addEventListener('ended', () => setPlayingUI(false));
  // The element fires `error` itself only for a failed `src`. With <source> children each failure fires at that
  // <source>, and it does not bubble — so without a CAPTURING listener the player never heard that every recording
  // had failed, and Play did nothing on a button that looked usable. Once every source has failed there is nothing
  // left to try for now — but that is a failed LOAD (a network hiccup is the usual cause), not "no recording": Play
  // stays available and tries again (see togglePlay).
  audioEl.addEventListener(
    'error',
    (event) => {
      if (event.target !== audioEl) {
        failedSources.add(event.target);
        if (failedSources.size < audioEl.querySelectorAll('source').length) return;
      }
      loadFailed = true;
      renderUI();
    },
    true
  );
  document.getElementById('anthem-player-root').appendChild(audioEl);
  return audioEl;
}

function updateProgress() {
  if (!uiRefs || !audioEl) return;
  const duration = audioEl.duration || 0;
  const pct = duration ? (audioEl.currentTime / duration) * 100 : 0;
  uiRefs.progressFill.style.width = `${pct}%`;
  uiRefs.elapsedEl.textContent = formatTime(audioEl.currentTime);
  uiRefs.totalEl.textContent = formatTime(duration);
}

function setPlayingUI(playing) {
  if (!uiRefs) return;
  uiRefs.playBtn.setAttribute('aria-label', playing ? 'Pause anthem' : 'Play anthem');
  uiRefs.icon.textContent = playing ? '⏸' : '▶';
}

function togglePlay() {
  if (unavailable || !audioEl) return;
  if (loadFailed) {
    applySources(currentMeta); // the files failed to load: rebuild the sources and ask for them again
    renderUI();
  }
  if (audioEl.paused) audioEl.play().catch(() => {});
  else audioEl.pause();
}

/**
 * @param {string} iso3
 * @param {{title: string, oggUrl: string|null, mp3Url: string|null, license: {shortName: string|null, credit: string|null}|null} | null} meta
 */
export function load(iso3, meta) {
  if (iso3 === currentIso3) {
    // Same country again (panel -> page, or after "Try again"): normally nothing changes and playback
    // must carry on. But if the recording itself is different — the first load had none because a
    // request failed — rebuild the sources, or the player stays "unavailable" for good.
    if (sourcesDiffer(currentMeta, meta)) {
      currentMeta = meta;
      applySources(meta);
    } else if (meta) {
      currentMeta = meta;
    }
    renderUI();
    return;
  }
  stop();
  currentIso3 = iso3;
  currentMeta = meta;
  applySources(meta);
  renderUI();
}

// (Re)builds the <audio> element's <source> list from `meta` and updates `unavailable` to match.
function applySources(meta) {
  failedSources.clear();
  loadFailed = false;
  unavailable = isUnavailable(meta);
  const audio = ensureAudioEl();
  audio.replaceChildren();
  if (unavailable) return;
  // MP3 first: Safari has unreliable/no native Ogg Vorbis support, and the browser
  // picks the first <source> it can actually play.
  if (meta.mp3Url) audio.appendChild(createEl('source', { attrs: { src: meta.mp3Url, type: 'audio/mpeg' } }));
  if (meta.oggUrl) audio.appendChild(createEl('source', { attrs: { src: meta.oggUrl, type: 'audio/ogg' } }));
  audio.load();
}

export function stop() {
  if (audioEl) {
    audioEl.pause();
    audioEl.currentTime = 0;
  }
}

export function isLoadedFor(iso3) {
  return currentIso3 === iso3;
}

function renderUI() {
  if (!mountedContainer) return;
  // The controls are rebuilt on every state change; a keyboard user who is on Play must still be on it afterwards.
  const playHadFocus = document.activeElement?.classList.contains('anthem-play-btn') && mountedContainer.contains(document.activeElement);
  mountedContainer.replaceChildren();

  const wrap = createEl('div', { className: 'anthem-player' });
  const playBtn = createEl('button', {
    className: 'anthem-play-btn',
    attrs: { type: 'button', 'aria-label': 'Play anthem', disabled: unavailable ? '' : null },
  });
  const icon = createEl('span', { attrs: { 'aria-hidden': 'true' }, text: '▶' });
  playBtn.appendChild(icon);
  playBtn.addEventListener('click', togglePlay);

  const body = createEl('div', { className: 'anthem-body' });
  const titleEl = createEl('p', { className: 'anthem-title', text: currentMeta?.title || 'National anthem' });
  const progressTrack = createEl('div', { className: 'anthem-progress-track' });
  const progressFill = createEl('div', { className: 'anthem-progress-fill' });
  progressTrack.appendChild(progressFill);
  const timeRow = createEl('div', { className: 'anthem-time-row' });
  const elapsedEl = createEl('span', { text: '0:00' });
  const totalEl = createEl('span', { text: '0:00' });
  timeRow.append(elapsedEl, createEl('span', { text: ' / ' }), totalEl);
  const licenseEl = createEl('p', {
    className: 'anthem-license',
    text: unavailable ? 'Recording unavailable' : loadFailed ? 'Recording could not be loaded. Press play to try again.' : formatLicense(currentMeta?.license) || '',
  });

  body.append(titleEl, progressTrack, timeRow, licenseEl);
  wrap.append(playBtn, body);
  mountedContainer.appendChild(wrap);

  uiRefs = { playBtn, icon, progressFill, elapsedEl, totalEl };
  setPlayingUI(!!audioEl && !audioEl.paused);
  updateProgress();
  if (playHadFocus && !unavailable) playBtn.focus();
}

/** @param {HTMLElement} container */
export function mountInto(container) {
  mountedContainer = container;
  renderUI();
}
