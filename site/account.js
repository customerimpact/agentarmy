// gridhive.dev/account: sign-in buttons, or the signed-in user (GET /api/auth/session).
// All values go into the page with textContent.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var error = new URLSearchParams(location.search).get('error');
  if (error) {
    $('error').textContent = error;
    $('error').hidden = false;
    history.replaceState(null, '', '/account');
  }

  function show(user) {
    $('signed-out').hidden = !!user;
    $('signed-in').hidden = !user;
    if (!user) return;
    $('who-name').textContent = user.name || user.email;
    $('who-email').textContent = user.email;
    if (user.image && /^https:\/\//.test(user.image)) {
      $('who-img').src = user.image;
      $('who-img').hidden = false;
    } else {
      $('who-initial').textContent = (user.name || user.email).charAt(0).toUpperCase();
      $('who-initial').hidden = false;
    }
  }

  fetch('/api/auth/session', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : { user: null }; })
    .then(function (data) { show(data.user); })
    .catch(function () { show(null); });

  $('signout').addEventListener('click', function () {
    fetch('/api/auth/signout', { method: 'POST', credentials: 'same-origin' }).finally(function () { show(null); });
  });
})();
