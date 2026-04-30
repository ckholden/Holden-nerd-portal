import { auth } from './firebase-config.js';
import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  indexedDBLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// Stay signed in across page reloads, browser restarts, and PWA launches.
// IndexedDB persistence is more durable than localStorage on iOS PWAs.
setPersistence(auth, indexedDBLocalPersistence).catch(() => {
  // Fallback to localStorage if IndexedDB blocked (rare)
  return setPersistence(auth, browserLocalPersistence);
}).catch((e) => console.warn('Auth persistence setup failed:', e));

let currentUser = null;
let cachedToken = null;
let tokenExpiry = 0;

export function getCurrentUser() {
  return currentUser;
}

export async function getIdToken() {
  if (!currentUser) throw new Error('Not authenticated');
  // Firebase tokens last 1 hour; refresh with 5-min buffer
  if (cachedToken && Date.now() < tokenExpiry - 300_000) return cachedToken;
  cachedToken = await currentUser.getIdToken(true);
  tokenExpiry = Date.now() + 3_600_000;
  return cachedToken;
}

export async function signIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signOut() {
  cachedToken = null;
  tokenExpiry = 0;
  return firebaseSignOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (!user) { cachedToken = null; tokenExpiry = 0; }
    callback(user);
  });
}
