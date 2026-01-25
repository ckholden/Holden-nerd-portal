// Check if user is logged in
function checkLogin() {
    if (localStorage.getItem('holdenPortalLoggedIn') !== 'true') {
        window.location.href = '/login';
    }
}

// Logout function
function logout() {
    localStorage.removeItem('holdenPortalLoggedIn');
    localStorage.removeItem('holdenPortalUsername');
    window.location.href = '/login';
}

// Run check on page load
document.addEventListener('DOMContentLoaded', checkLogin);
