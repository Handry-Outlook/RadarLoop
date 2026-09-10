/**
 * Firebase access for the two outlook feeds.
 *
 * Two apps are involved: the default app holds automated HOCO runs and their
 * Storage-hosted GeoJSON, while a secondary named app holds the manually
 * published Handry Outlook forecasts. Initialisation is lazy and idempotent so
 * neither feed costs anything until its panel is opened.
 */

import { FIREBASE_MAIN, FIREBASE_OUTLOOK, FIREBASE_OUTLOOK_APP_NAME } from '../config.js';
import { DEPS } from '../core/deps.js';

let mainApp = null;
let outlookApp = null;

const sdkReady = () => typeof firebase !== 'undefined' && typeof firebase.initializeApp === 'function';

function existingApp(name) {
  try {
    return name ? firebase.app(name) : firebase.app();
  } catch {
    return null;
  }
}

/**
 * Fetches the Firebase SDK.
 *
 * Three compat bundles come to 399 KB and are only needed by the outlook
 * panels, so nothing is loaded until one of them is opened.
 */
export function loadFirebase() {
  return DEPS.firebase();
}

export function getMainApp() {
  if (mainApp) return mainApp;
  if (!sdkReady()) return null;
  mainApp = existingApp() || firebase.initializeApp(FIREBASE_MAIN);
  return mainApp;
}

export function getOutlookApp() {
  if (outlookApp) return outlookApp;
  if (!sdkReady()) return null;
  outlookApp = existingApp(FIREBASE_OUTLOOK_APP_NAME) ||
    firebase.initializeApp(FIREBASE_OUTLOOK, FIREBASE_OUTLOOK_APP_NAME);
  return outlookApp;
}

export const mainDb = () => getMainApp()?.firestore() ?? null;
export const outlookDb = () => getOutlookApp()?.firestore() ?? null;

/** Storage is only needed to resolve auto-HOCO GeoJSON download URLs. */
export function storageUrl(gsUrl) {
  const app = getMainApp();
  if (!app || typeof app.storage !== 'function') return Promise.reject(new Error('Firebase Storage unavailable'));
  return app.storage().refFromURL(gsUrl).getDownloadURL();
}

export const firestoreTimestamp = (seconds) =>
  new firebase.firestore.Timestamp(Math.floor(seconds), 0);
