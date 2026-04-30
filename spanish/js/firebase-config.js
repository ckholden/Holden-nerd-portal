// Fill in your Firebase project config here.
// Get it from: Firebase Console → Project Settings → Your apps → Web app → SDK snippet
// This file is safe to commit — these values are public.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBZm58tQpe6SnKizDcEqM_ZHKhosq7A4HI',
  authDomain: 'maestra-lupita.firebaseapp.com',
  databaseURL: 'https://maestra-lupita-default-rtdb.firebaseio.com',
  projectId: 'maestra-lupita',
  storageBucket: 'maestra-lupita.firebasestorage.app',
  messagingSenderId: '684499703881',
  appId: '1:684499703881:web:dd4453fe6b54b36cfb0798',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
