// gridhive.dev/link?code=ABCD-EFGH: the signed-in user approves linking the app on their computer.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var raw = new URLSearchParams(location.search).get('code') || '';
  var code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  var msg = function (text, kind) { $('msg').textContent = text; $('msg').className = 'msg' + (kind ? ' ' + kind : ''); };

  if (code.length !== 8) {
    $('code').textContent = '—';
    msg('This link has no code. Start "Sign in" again in the GridHive app.', 'err');
    return;
  }
  var pretty = code.slice(0, 4) + '-' + code.slice(4);
  $('code').textContent = pretty;
  var back = encodeURIComponent('/link?code=' + pretty);
  $('gh').href = '/api/auth/signin/github?next=' + back;
  $('gg').href = '/api/auth/signin/google?next=' + back;

  fetch('/api/auth/session', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : { user: null }; })
    .then(function (data) {
      if (data.user) {
        $('title').textContent = 'Link this computer to your account';
        $('sub').textContent = 'Signed in as ' + (data.user.name ? data.user.name + ' (' + data.user.email + ')' : data.user.email) + '. Check that this code matches the one in the GridHive app.';
        $('link').textContent = 'Link this computer to ' + data.user.email;
        $('confirm').hidden = false;
      } else {
        $('title').textContent = 'Sign in to link your computer';
        $('sub').textContent = 'Sign in or create your free account with GitHub or Google. Then you link this computer to it.';
        $('signin').hidden = false;
      }
    })
    .catch(function () { $('signin').hidden = false; });

  $('link').addEventListener('click', function () {
    $('link').disabled = true;
    msg('Linking…');
    fetch('/api/devices/confirm', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: pretty }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || 'Could not link');
        $('title').textContent = 'Computer linked';
        $('confirm').hidden = true;
        msg((r.data.name || 'Your computer') + ' is linked. You can close this tab and go back to GridHive.', 'ok');
      })
      .catch(function (err) {
        $('link').disabled = false;
        msg(err.message, 'err');
      });
  });
})();
