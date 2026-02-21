(function () {
    if (localStorage.getItem('portal_auth') !== 'true') {
        window.location.replace('/portal-login');
    }
})();
