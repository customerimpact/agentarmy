// Animated hero: start a session, spawn a team, jobs fly, answer from your phone, work continues.
// A timeline of small events; clicking a step seeks there. Reduced motion shows the finished board.
(function () {
  var root = document.getElementById('demo');
  if (!root) return;
  var $ = function (sel) { return root.querySelector(sel); };
  var node = function (a) { return root.querySelector('.d-node[data-a="' + a + '"]'); };
  var row = function (a) { return root.querySelector('.d-row[data-a="' + a + '"]'); };
  var LOOP_MS = 19500;
  var STEP_AT = [0, 4200, 6200, 9800, 13600];
  var LABEL = { idle: 'Ready', working: 'Working', needs: 'Needs you', done: 'Done' };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var timers = [];
  var startedAt = 0;
  var offset = 0;
  var running = false;

  function show(a) {
    node(a).classList.add('on');
    row(a).classList.add('on');
    $('.d-count').textContent = root.querySelectorAll('.d-row.on').length;
  }
  function status(a, s) {
    [node(a), row(a)].forEach(function (el) { el.dataset.s = s; });
    node(a).querySelector('.d-pill').textContent = LABEL[s];
    root.classList.toggle('needs', !!root.querySelector('.d-node[data-s="needs"]'));
  }
  // Appends text to an element, a few characters at a time unless instant
  function type(el, text, instant, speed) {
    if (instant) { el.textContent += text; return; }
    var i = 0;
    (function tick() {
      el.textContent += text.slice(i, i + 2);
      i += 2;
      if (i < text.length) timers.push(setTimeout(tick, speed || 28));
    })();
  }
  var term = function (a) { return node(a).querySelector('.d-term'); };
  function step(n) {
    root.dataset.step = n;
    root.querySelectorAll('.demo-steps button').forEach(function (b, i) {
      b.setAttribute('aria-selected', String(i === n));
    });
  }

  var EVENTS = [
    [0, function () { step(0); }],
    [300, function (i) { type($('.d-cmd-text'), 'Build the checkout page with Stripe', i, 34); }],
    [1700, function () { show('ada'); status('ada', 'working'); root.classList.add('sent'); }],
    [1900, function (i) { type(term('ada'), '> Build the checkout page\n● Planning 3 jobs…', i); }],
    [4200, function () { step(1); show('bex'); status('bex', 'idle'); }],
    [4600, function () { show('cy'); status('cy', 'idle'); }],
    [5000, function () { show('dax'); status('dax', 'idle'); }],
    [5100, function (i) { ['bex', 'cy', 'dax'].forEach(function (a) { type(term(a), 'ready', i); }); }],
    [6200, function (i) { step(2); root.classList.add('jobs'); type(term('ada'), '\n→ 3 jobs sent', i); }],
    [6900, function (i) { status('bex', 'working'); term('bex').textContent = ''; type(term('bex'), '● Edit src/Checkout.tsx\n● Add card form', i); }],
    [7300, function (i) { status('cy', 'working'); term('cy').textContent = ''; type(term('cy'), '● Write api/pay.ts\n● Stripe webhook', i); }],
    [7700, function (i) { status('dax', 'working'); term('dax').textContent = ''; type(term('dax'), '● Waiting for changes…', i); }],
    [9800, function (i) { step(3); status('cy', 'needs'); type(term('cy'), '\n? Run npm test (y/n)', i); }],
    [10400, function () { root.classList.add('phone'); }],
    [12000, function () { root.classList.add('tapped'); }],
    [12600, function (i) { root.classList.remove('phone'); status('cy', 'working'); type(term('cy'), '\n✓ Allowed from phone\n● 24 tests passed', i); }],
    [13600, function () { step(4); }],
    [13900, function (i) { status('bex', 'done'); type(term('bex'), '\n✓ Done', i); }],
    [14700, function (i) { status('cy', 'done'); type(term('cy'), '\n✓ Done', i); }],
    [15000, function (i) { term('dax').textContent = ''; type(term('dax'), '● Reviewing 6 files…', i); }],
    [16400, function (i) { status('dax', 'done'); type(term('dax'), '\n✓ Looks good', i); }],
    [17000, function (i) { status('ada', 'done'); root.classList.remove('jobs'); type(term('ada'), '\n✓ Ready to review', i); }],
  ];

  function reset() {
    root.classList.remove('sent', 'jobs', 'phone', 'tapped', 'needs');
    root.querySelectorAll('.d-node, .d-row').forEach(function (el) { el.classList.remove('on'); delete el.dataset.s; });
    root.querySelectorAll('.d-term').forEach(function (el) { el.textContent = ''; });
    $('.d-cmd-text').textContent = '';
    $('.d-count').textContent = '0';
  }

  function clear() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  // Applies everything before t at once, then schedules the rest
  function playFrom(t) {
    clear();
    reset();
    EVENTS.forEach(function (e) { if (e[0] < t) e[1](true); });
    if (reduce) return;
    running = true;
    offset = t;
    startedAt = performance.now();
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
