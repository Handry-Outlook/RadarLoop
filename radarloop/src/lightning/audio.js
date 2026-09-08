/**
 * The strike cue.
 *
 * Uses the same audio file as the original build.
 *
 * ## Why this is more than `audio.play()`
 *
 * Browsers block audio until the page has had a real user gesture, and a
 * rejected `play()` returns a promise that fails silently. That is the usual
 * reason a cue "works sometimes": whether it plays depends on whether the user
 * happened to click something first. So the element is unlocked on the first
 * gesture of any kind, and playback failures are surfaced once rather than
 * swallowed.
 *
 * A single `<audio>` element also cannot overlap with itself — restarting it
 * mid-play cuts the previous sound off. A small round-robin pool lets closely
 * spaced strikes layer instead of truncating each other.
 */

import { ASSETS } from '../config.js';

const POOL_SIZE = 4;
/** Matches the original's rate limit. */
const COOLDOWN_MS = 50;

let pool = [];
let cursor = 0;
let unlocked = false;
let lastPlayed = 0;
let warned = false;
let volume = 0.7;

function createPool() {
  if (pool.length) return pool;
  pool = Array.from({ length: POOL_SIZE }, () => {
    const audio = new Audio(ASSETS.thunderSound);
    audio.preload = 'auto';
    audio.volume = volume;
    return audio;
  });
  return pool;
}

/**
 * Primes playback on the first user gesture.
 *
 * A muted play/pause satisfies the autoplay policy for every element in the
 * pool, so the first real strike is audible rather than being the one that gets
 * blocked.
 */
export function installAudioUnlock() {
  if (unlocked) return;

  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    for (const audio of createPool()) {
      audio.muted = true;
      audio.play()
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
        })
        .catch(() => {
          audio.muted = false;
        });
    }
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      window.removeEventListener(type, unlock);
    }
  };

  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(type, unlock, { passive: true });
  }
}

export function setVolume(value) {
  volume = Math.max(0, Math.min(1, value));
  for (const audio of pool) audio.volume = volume;
}

/**
 * Plays the cue, rate-limited.
 * @returns {boolean} whether a sound was actually started
 */
export function playStrikeSound() {
  const now = Date.now();
  if (now - lastPlayed < COOLDOWN_MS) return false;
  lastPlayed = now;

  const audio = createPool()[cursor];
  cursor = (cursor + 1) % POOL_SIZE;

  try {
    audio.currentTime = 0;
    const played = audio.play();
    // Older browsers return undefined rather than a promise.
    played?.catch((error) => {
      if (warned) return;
      warned = true;
      console.warn('[audio] strike cue blocked by the browser:', error?.name || error);
    });
    return true;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn('[audio] strike cue failed:', error);
    }
    return false;
  }
}

/** True once a user gesture has primed playback. */
export const isUnlocked = () => unlocked;

/**
 * Pool diagnostics.
 *
 * The elements are created with `new Audio()` and never attached to the
 * document, so they cannot be inspected through the DOM — this is the only way
 * to observe whether the cue is really loading and playing.
 */
export const poolState = () => pool.map((audio) => ({
  readyState: audio.readyState,
  paused: audio.paused,
  currentTime: audio.currentTime,
  duration: Number.isFinite(audio.duration) ? audio.duration : null,
  error: audio.error ? audio.error.code : null,
}));
