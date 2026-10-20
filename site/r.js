// Shows a recipe from https://gridhive.dev/r#<code>. The code never leaves the browser (it is after "#").
// Same format as src/shared/recipes.ts; every value goes into the page with textContent only.
(function () {
  var AGENTS = { codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', grok: 'Grok' };
  var LOCAL_PORT = 4317;
  var $ = function (id) { return document.getElementById(id); };

  function decode(code) {
    var binary = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = Uint8Array.from(binary, function (c) { return c.charCodeAt(0); });
    var packed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!packed || typeof packed.n !== 'string' || !Array.isArray(packed.r) || !packed.r.length) throw new Error('bad');
    if (packed.v > 1) throw new Error('newer');
    return packed;
  }

  function str(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

  function fail(message) {
    $('name').textContent = 'This recipe link is broken';
    $('description').textContent = message;
    $('description').className = 'lead error';
  }

  var code = (location.hash || '').slice(1);
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    fail('Ask for the link again: it should end in "#" followed by a long code.');
    return;
  }
  var recipe;
  try {
    recipe = decode(code);
  } catch (e) {
    fail(e.message === 'newer' ? 'It was made by a newer GridHive. Update the app, then open it from there.' : 'Ask for the link again; part of it is missing.');
    return;
  }

  var name = str(recipe.n, 60) || 'Untitled recipe';
  document.title = name + ' · GridHive recipe';
  $('name').textContent = name;
  $('description').textContent = str(recipe.d, 200) || recipe.r.length + (recipe.r.length === 1 ? ' agent' : ' agents');
  $('open-app').href = 'gridhive://recipe?d=' + code;
  $('open-local').href = 'http://127.0.0.1:' + LOCAL_PORT + '/#recipe=' + code;
  $('copy').addEventListener('click', function () {
    navigator.clipboard.writeText(location.href).then(function () {
      $('copied').hidden = false;
      setTimeout(function () { $('copied').hidden = true; }, 1500);
    });
  });

  var list = $('rows');
  recipe.r.slice(0, 12).forEach(function (row, i) {
    var li = document.createElement('li');
    var head = document.createElement('div');
    head.className = 'row-head';
    var who = document.createElement('b');
    who.textContent = str(row.n, 40) || 'Agent ' + (i + 1);
    var role = document.createElement('span');
    role.textContent = str(row.ro, 40) || 'General';
    var tag = document.createElement('span');
    tag.className = 'tag';
    var model = str(row.m, 200);
    tag.textContent = (AGENTS[row.a] || 'Claude Code') + (model ? ' · ' + model : '') + (row.w ? ' · own branch' : '');
    head.append(who, role, tag);
    li.append(head);
    var prompt = str(row.p, 8000);
    if (prompt) {
      var pre = document.createElement('pre');
      pre.textContent = prompt;
      li.append(pre);
    }
    list.append(li);
  });
  $('ready').hidden = false;
})();
