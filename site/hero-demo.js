// Animated hero: a small copy of the GridHive app (Midnight theme) telling one story in 5 steps:
// start a session, spawn a team, jobs fly, answer from your phone, work continues.
// A timeline of events; clicking a step seeks there. Reduced motion shows the finished board.
(function () {
  var root = document.getElementById('demo');
  if (!root) return;
  var $ = function (sel) { return root.querySelector(sel); };
  var node = function (a) { return root.querySelector('.x-node[data-a="' + a + '"]'); };
  var row = function (a) { return root.querySelector('.x-row[data-a="' + a + '"]'); };
  var term = function (a) { return node(a).querySelector('.x-term'); };
  var LOOP_MS = 23000;
  var STEP_AT = [0, 4300, 6800, 10600, 14600];
  var NODE_LABEL = { starting: 'STARTING', idle: 'IDLE', working: 'WORKING', needs: 'NEEDS YOU', resting: 'RESTING' };
  var PILL_LABEL = { starting: 'starting', idle: 'idle', working: 'running', needs: 'needs you', resting: 'done' };
  var TODOS = { bex: 3, cy: 3, dax: 2 };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var timers = [];
  var clock = null;
  var startedAt = 0;
  var offset = 0;
  var running = false;
  var since = {};
  var done = { bex: 0, cy: 0, dax: 0 };

  // ---------- helpers ----------
  function on(el) { el.classList.add('on'); }
  function flag(name, value) { root.classList.toggle(name, value !== false); }
  function tab(name) { root.dataset.tab = name; }
  function count() {
    $('.x-count').textContent = root.querySelectorAll('.x-row.on').length;
    var team = ['bex', 'cy', 'dax'];
    var busy = team.filter(function (a) { return node(a).dataset.s === 'working'; }).length;
    $('.x-group[data-g="team"] .x-gsum').textContent = busy + '/3 working';
    $('.x-frame-team .x-fsum').textContent = '3 · ' + busy + ' working';
    flag('needs', !!root.querySelector('.x-node[data-s="needs"]'));
  }
  function status(a, s) {
    node(a).dataset.s = s;
    row(a).dataset.s = s;
    node(a).querySelector('.x-st').textContent = NODE_LABEL[s];
    row(a).querySelector('.x-pill').textContent = PILL_LABEL[s];
    since[a] = performance.now();
    tick();
    count();
  }
  function show(a) {
    on(node(a));
    on(row(a));
    status(a, 'starting');
  }
  // Seconds since each status change, like the app's pills
  function tick() {
    Object.keys(since).forEach(function (a) {
      var s = Math.max(0, Math.round((performance.now() - since[a]) / 1000)) + 's';
      node(a).querySelector('.x-sec').textContent = s;
      row(a).querySelector('.x-time').textContent = s;
    });
  }
  function progress(a, n) {
    done[a] = n;
    var el = root.querySelector('.x-prog[data-a="' + a + '"]');
    el.querySelector('.x-pn').textContent = n + '/' + TODOS[a];
    el.querySelector('u').style.setProperty('--p', (100 * n) / TODOS[a] + '%');
    var all = done.bex + done.cy + done.dax;
    var total = el.parentNode.querySelector('.x-prog-all');
    total.querySelector('.x-pn').textContent = all + '/8 tasks';
    total.querySelector('u').style.setProperty('--p', (100 * all) / 8 + '%');
  }

  // Appends colored segments [[class, text], ...], a few characters at a time unless instant
  function write(el, segments, instant, speed) {
    var parts = segments.map(function (seg) {
      var span = document.createElement('span');
      if (seg[0]) span.className = seg[0];
      el.appendChild(span);
      return { span: span, text: seg[1] };
    });
    if (instant) {
      parts.forEach(function (p) { p.span.textContent = p.text; });
      el.scrollTop = el.scrollHeight;
      return;
    }
    var i = 0;
    var pos = 0;
    (function next() {
      if (i >= parts.length) return;
      var p = parts[i];
      p.span.textContent = p.text.slice(0, (pos += 3));
      el.scrollTop = el.scrollHeight;
      if (pos >= p.text.length) { i++; pos = 0; }
      timers.push(setTimeout(next, speed || 16));
    })();
  }
  function typeInput(text, instant) {
    var el = $('.x-typed');
    if (instant) { el.textContent = text; return; }
    var i = 0;
    (function next() {
      el.textContent = text.slice(0, ++i);
      if (i < text.length) timers.push(setTimeout(next, 38));
    })();
  }
  var banner = function (a, name) {
    var head = { claude: [['o', '✱ '], ['', 'Claude Code\n']], codex: [['c', '>_ '], ['', 'OpenAI Codex\n']], gemini: [['c', '✦ '], ['', 'Gemini CLI\n']] }[name];
    return head.concat([['d', 'C:\\shop\n\n']]);
  };

  // ---------- the story ----------
  var EVENTS = [
    [0, function () { step(0); tab('agents'); }],
    [300, function (i) { typeInput('Build the checkout page with Stripe', i); }],
    [1900, function () { flag('sending'); flag('sent'); $('.x-typed').textContent = ''; $('.x-target-name').textContent = 'Ada'; }],
    [2000, function () { on($('.x-frame-orch')); on($('.x-group[data-g="orch"]')); show('ada'); }],
    [2200, function (i) { write(term('ada'), banner('ada', 'claude'), i); }],
    [2700, function (i) { status('ada', 'working'); write(term('ada'), [['', '> Build the checkout page with Stripe\n'], ['o', '● '], ['', 'Planning 3 jobs…\n'], ['d', '  └ Read src/app.ts, package.json\n']], i); }],

    [4300, function () { step(1); flag('sending', false); on($('.x-frame-team')); on($('.x-group[data-g="team"]')); }],
    [4500, function (i) { show('bex'); write(term('bex'), banner('bex', 'claude'), i); }],
    [4900, function (i) { show('cy'); write(term('cy'), banner('cy', 'codex'), i); }],
    [5300, function (i) { show('dax'); write(term('dax'), banner('dax', 'gemini'), i); }],
    [5900, function (i) {
      ['bex', 'cy', 'dax'].forEach(function (a) { status(a, 'idle'); write(term(a), [['', '> ready\n']], i); });
    }],

    [6800, function (i) { step(2); flag('jobs'); write(term('ada'), [['c', '→ '], ['', 'send_job Bex · Checkout UI\n'], ['c', '→ '], ['', 'send_job Cy · Payments API\n'], ['c', '→ '], ['', 'send_job Dax · Review changes\n']], i); }],
    [7600, function (i) { status('bex', 'working'); write(term('bex'), [['o', '● '], ['', 'Edit src/Checkout.tsx\n'], ['d', '  └ Added 42 lines\n']], i); }],
    [8000, function (i) { status('cy', 'working'); write(term('cy'), [['c', '• '], ['', 'Write api/pay.ts\n'], ['c', '• '], ['', 'Add Stripe webhook\n']], i); }],
    [8400, function (i) { status('dax', 'working'); write(term('dax'), [['c', '✦ '], ['', 'Waiting for changes…\n']], i); }],
    [9200, function () { progress('bex', 1); progress('cy', 1); }],

    [10600, function (i) {
      step(3);
      status('cy', 'needs');
      write(term('cy'), [['box', '╭ '], ['', 'Run '], ['y', 'npm test'], ['', '?\n'], ['sel', '│ ❯ 1. Yes\n'], ['box', '│   2. Yes, and don\'t ask again\n'], ['box', '╰   3. No (esc)\n']], i);
    }],
    [11100, function () { tab('actions'); }],
    [11500, function () { flag('phone'); }],
    [13300, function () { flag('tapped'); }],
    [13700, function (i) { flag('answered'); status('cy', 'working'); write(term('cy'), [['g', '✓ '], ['', 'Allowed from phone\n'], ['c', '• '], ['', 'npm test: 24 passed\n']], i); progress('cy', 2); }],
    [14200, function () { flag('phone', false); }],

    [14600, function () { step(4); tab('progress'); flag('reports'); progress('bex', 2); }],
    [15200, function (i) { status('bex', 'resting'); progress('bex', 3); write(term('bex'), [['g', '✓ '], ['', 'Done · reported to Ada\n']], i); }],
    [16000, function (i) { status('cy', 'resting'); progress('cy', 3); write(term('cy'), [['g', '✓ '], ['', 'Done · reported to Ada\n']], i); }],
    [16600, function (i) { progress('dax', 1); write(term('dax'), [['c', '✦ '], ['', 'Reviewing 6 files…\n']], i); }],
    [18200, function (i) { status('dax', 'resting'); progress('dax', 2); write(term('dax'), [['g', '✓ '], ['', 'Looks good, 0 issues\n']], i); }],
    [18900, function (i) { status('ada', 'resting'); flag('calm'); write(term('ada'), [['g', '✓ '], ['', 'All 3 jobs done · ready to review\n']], i); }],
  ];

  function step(n) {
    root.dataset.step = n;
    root.querySelectorAll('.demo-steps button').forEach(function (b, i) {
      b.setAttribute('aria-selected', String(i === n));
    });
  }

  function reset() {
    ['sent', 'sending', 'jobs', 'reports', 'calm', 'phone', 'tapped', 'answered', 'needs'].forEach(function (c) { root.classList.remove(c); });
    root.querySelectorAll('.x-node, .x-row, .x-frame, .x-group').forEach(function (el) { el.classList.remove('on'); delete el.dataset.s; });
    root.querySelectorAll('.x-term').forEach(function (el) { el.textContent = ''; });
    $('.x-typed').textContent = '';
    $('.x-target-name').textContent = 'Board';
    since = {};
    done = { bex: 0, cy: 0, dax: 0 };
    ['bex', 'cy', 'dax'].forEach(function (a) { progress(a, 0); });
    count();
  }

  function clear() {
    timers.forEach(clearTimeout);
    timers = [];
    if (clock) clearInterval(clock);
    clock = null;
  }

  // Applies everything before t at once, then schedules the rest
  function playFrom(t) {
    clear();
    reset();
    EVENTS.forEach(function (e) { if (e[0] < t) e[1](true); });
    // Seeking lands mid-story: make the timers read like the agents have been at it a while
    Object.keys(since).forEach(function (a, k) { since[a] = performance.now() - (4 + k * 3) * 1000; });
    tick();
    if (reduce) return;
    running = true;
    offset = t;
    startedAt = performance.now();
    clock = setInterval(tick, 1000);
    EVENTS.forEach(function (e) {
      if (e[0] >= t) timers.push(setTimeout(function () { e[1](false); }, e[0] - t));
    });
    timers.push(setTimeout(function () {
      root.classList.add('fade');
      timers.push(setTimeout(function () { root.classList.remove('fade'); playFrom(0); }, 600));
    }, LOOP_MS - t));
  }

  function now() { return offset + (performance.now() - startedAt); }

  root.querySelectorAll('.demo-steps button').forEach(function (b) {
    b.addEventListener('click', function () { playFrom(STEP_AT[Number(b.dataset.go)]); });
  });

  if (reduce) {
    playFrom(LOOP_MS);
    return;
  }
  // Only animate while the demo is on screen
  var paused = null;
  new IntersectionObserver(function (entries) {
    var visible = entries[0].isIntersecting;
    if (visible && paused !== null) { playFrom(paused); paused = null; }
    else if (visible && !running) playFrom(0);
    else if (!visible && running) { paused = Math.min(now(), LOOP_MS - 1); clear(); running = false; }
  }, { threshold: 0.15 }).observe(root);
})();
