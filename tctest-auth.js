// Check if user is logged in for TC CAD
function checkTCCADLogin() {
    if (localStorage.getItem('tccadLoggedIn') !== 'true') {
        window.location.href = '/tctest-login';
    }
}

// Logout function for TC CAD
function logoutTCCAD() {
    localStorage.removeItem('tccadLoggedIn');
    localStorage.removeItem('tccadUsername');
    window.location.href = '/tctest-login';
}

// Run check on page load
document.addEventListener('DOMContentLoaded', checkTCCADLogin);
