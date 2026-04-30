import { auth } from './firebase-config.js';
import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  indexedDBLocalPersistence,
  inMemoryPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// Persistence with full fallback chain: IndexedDB → localStorage → in-memory.
// In-memory means we lose auth on app close but at least sign-in works.
// iOS PWAs sometimes restrict IndexedDB unexpectedly.
(async () => {
  for (const p of [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence]) {
    try { await setPersistence(auth, p); return; } catch (e) { /* try next */ }
  }
  console.warn('All auth persistence types failed — auth may not persist');
})();

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
  // Race against a 15s timeout so a hung network doesn't lock up the UI forever
  const signInPromise = signInWithEmailAndPassword(auth, email, password);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error('Sign-in timed out (15s) — check your connection'), { code: 'auth/timeout' })), 15000)
  );
  const cred = await Promise.race([signInPromise, timeoutPromise]);
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
