// Pure decisions about an anthem's recording, split out of AnthemPlayer.js (which owns a singleton
// <audio> element and cannot run outside a browser) so they can be tested.

/** True when there is no recording to play. */
export function isUnavailable(meta) {
  return !meta || (!meta.oggUrl && !meta.mp3Url);
}

/**
 * Does `next` offer different audio than `current`? A later load for the SAME country is normally a
 * no-op — it must not interrupt playback when the user moves between the panel and the page — but if
 * the recording itself changed (the first load had none because a request failed, and "Try again"
 * brought it) the player has to rebuild its sources. A missing `next` never counts as a change.
 */
export function sourcesDiffer(current, next) {
  if (!next) return false;
  return (current?.oggUrl ?? null) !== (next.oggUrl ?? null) || (current?.mp3Url ?? null) !== (next.mp3Url ?? null);
}
