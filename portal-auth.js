// Holden Portal — Firebase Auth Gate
// To grant access: add the person's Google account email to ALLOWED_EMAILS

var ALLOWED_EMAILS = [
    'christiankholden@gmail.com',
    'karmenn_holden@hotmail.com',
    'holden3361@gmail.com',
    'njk50@aol.com',
    'pck40@aol.com',
    'mthviers@gmail.com',
    'kenkaster@hotmail.com',
    'anniekaster@hotmail.com',
    '1kurtkaster@gmail.com'
];

var FIREBASE_CONFIG = {
    apiKey: "AIzaSyArDL_Cd-xDlmA_92xiaDKXXrSLHPbFUNU",
    authDomain: "holden-portal.firebaseapp.com",
    projectId: "holden-portal",
    storageBucket: "holden-portal.firebasestorage.app",
    messagingSenderId: "659387054117",
    appId: "1:659387054117:web:cf420bfd3a348e5aa6a7cc"
};

// Hide page until auth is confirmed — prevents flash of content before redirect
document.documentElement.style.visibility = 'hidden';

if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
}

firebase.auth().onAuthStateChanged(function (user) {
    if (user && ALLOWED_EMAILS.indexOf(user.email.toLowerCase()) !== -1) {
        // Authorized — show page
        document.documentElement.style.visibility = 'visible';
    } else {
        // Not signed in or not on the list — send to login
        if (user) firebase.auth().signOut();
        window.location.replace('/portal-login?next=' + encodeURIComponent(window.location.pathname));
    }
});
