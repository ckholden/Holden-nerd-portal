// 878 Codeplug tool — page-local auth gate (Christian / Chris KK7ION / Pete KK7RBQ only)
// This is a NARROWER allowlist than the site-wide portal-auth.js on purpose — this tool
// is only for the 3 people who use this codeplug, not everyone with portal access.
// To grant access: add the person's Google account email below.

var ALLOWED_EMAILS = [
    'christiankholden@gmail.com', // KJ7DTS
    'holden3361@gmail.com',       // KK7ION (Chris / dad)
    'pck40@aol.com'               // KK7RBQ (Pete / grandpa)
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
        document.documentElement.style.visibility = 'visible';
    } else {
        if (user) firebase.auth().signOut();
        window.location.replace('/portal-login?next=' + encodeURIComponent(window.location.pathname));
    }
});
