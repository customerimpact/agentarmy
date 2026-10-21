(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shot = (name, w) => `/assets/shots/${name}-${w}.webp`;
  const srcset = (name) => `${shot(name, 800)} 800w, ${shot(name, 1600)} 1600w`;

  // Nav border once the page scrolls
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Swap an image with a short fade
  function swap(img, name, alt) {
    const next = new Image();
    next.srcset = srcset(name);
    next.sizes = img.sizes;
    next.src = shot(name, 1600);
    const apply = () => {
      img.srcset = next.srcset;
      img.src = next.src;
      img.alt = alt;
      img.classList.remove('fading');
    };
    if (reduce) return apply();
    img.classList.add('fading');
    (next.decode ? next.decode() : Promise.resolve()).then(apply, apply);
  }

  // Roving-focus groups (tabs and theme radios)
  function group(buttons, attr, onPick) {
    const pick = (btn, focus) => {
      buttons.forEach((b) => {
        const on = b === btn;
        b.setAttribute(attr, String(on));
        b.tabIndex = on ? 0 : -1;
      });
      if (focus) btn.focus();
      onPick(btn);
    };
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => pick(btn, false));
      btn.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          pick(buttons[e.key === 'Home' ? 0 : buttons.length - 1], true);
        } else if (step) {
          e.preventDefault();
          pick(buttons[(i + step + buttons.length) % buttons.length], true);
        }
      });
    });
  }

  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  const tourImg = document.getElementById('tour-img');
  const tourCap = document.getElementById('tour-cap');
  const panel = document.getElementById('tour-panel');
  group(tabs, 'aria-selected', (btn) => {
    swap(tourImg, btn.dataset.shot, btn.dataset.cap);
    tourCap.textContent = btn.dataset.cap;
    panel.setAttribute('aria-labelledby', btn.id);
  });

  const themeImg = document.getElementById('theme-img');
  const themeNames = { midnight: 'board', ember: 'theme-ember', aurora: 'theme-aurora', paper: 'theme-paper' };
  group([...document.querySelectorAll('.swatches [role="radio"]')], 'aria-checked', (btn) => {
    swap(themeImg, themeNames[btn.dataset.theme], `The board in the ${btn.textContent.trim()} theme`);
  });

  // Copy buttons (npx line, run from source)
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    const label = btn.querySelector('span');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.classList.add('ok');
        label.textContent = 'Copied';
      } catch {
        label.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => {
        btn.classList.remove('ok');
        label.textContent = 'Copy';
      }, 1800);
    });
  });

  // Fade sections in as they scroll into view
  if (!reduce && 'IntersectionObserver' in window) {
    const items = document.querySelectorAll('.section .head, .split > *, .grid .card, .tabs, .tour, .themes > *, .local, .install > *, .source, .faq, .final-card, .ways .card, .compare-scroll');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          io.unobserve(e.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    items.forEach((el, i) => {
      el.classList.add('reveal');
      if (el.classList.contains('card')) el.style.transitionDelay = `${(i % 3) * 70}ms`;
      io.observe(el);
    });
  }

  // Freeze the SVG animation for people who asked for less motion
  if (reduce) document.querySelectorAll('.diagram svg').forEach((svg) => svg.pauseAnimations && svg.pauseAnimations());

  // GitHub star count on every star button (optional; the buttons work without it)
  const counts = document.querySelectorAll('[data-stars]');
  if (counts.length && 'fetch' in window) {
    fetch('https://api.github.com/repos/customerimpact/gridhive', { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((repo) => {
        if (!repo || typeof repo.stargazers_count !== 'number' || repo.stargazers_count < 1) return;
        const n = repo.stargazers_count;
        counts.forEach((count) => {
          count.textContent = `★ ${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n}`;
          count.hidden = false;
        });
      })
      .catch(() => {});
  }

  // Show only the download for this computer's OS (both stay when we can't tell, e.g. Linux)
  const ua = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
  const os = /mac/i.test(ua) ? 'mac' : /win/i.test(ua) ? 'win' : null;
  if (os) {
    document.querySelectorAll('[data-os]').forEach((btn) => {
      if (btn.dataset.os !== os) btn.hidden = true;
    });
  }

  // Language menu: mark the current language, close on outside click or Escape
  const lang = document.querySelector('.lang');
  if (lang) {
    const here = location.pathname.split('/')[1];
    lang.querySelectorAll('a').forEach((a) => {
      const code = a.getAttribute('href').split('/')[1];
      if (code === here || (!code && !/^(zh|ja|es|de|fr|nl)$/.test(here))) a.setAttribute('aria-current', 'true');
    });
    document.addEventListener('click', (e) => { if (!lang.contains(e.target)) lang.open = false; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lang.open = false; });
  }

  // OS tabs on the docs pages
  document.querySelectorAll('.ostabs').forEach((bar) => {
    const buttons = [...bar.querySelectorAll('[role="tab"]')];
    group(buttons, 'aria-selected', (btn) => {
      buttons.forEach((b) => { document.getElementById(b.getAttribute('aria-controls')).hidden = b !== btn; });
    });
    const mine = os && buttons.find((b) => b.dataset.tabOs === os);
    if (mine) mine.click();
  });

  // Docs pages: highlight the section you're reading in the side menu
  const tocLinks = [...document.querySelectorAll('.toc a')];
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(tocLinks.map((a) => [a.getAttribute('href').slice(1), a]));
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        tocLinks.forEach((a) => a.classList.toggle('on', a === byId.get(e.target.id)));
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    byId.forEach((_, id) => { const el = document.getElementById(id); if (el) spy.observe(el); });
  }
})();

// Early-access waitlist -> POST /api/waitlist (Vercel + Neon)
(function () {
  var form = document.getElementById('waitlist');
  if (!form) return;
  var msg = form.querySelector('.waitlist-msg');
  var button = form.querySelector('button');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
      msg.textContent = 'Enter your email address.';
      msg.className = 'waitlist-msg err';
      return;
    }
    button.disabled = true;
    msg.textContent = 'Saving…';
    msg.className = 'waitlist-msg';
    fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, company: form.company.value, source: 'final-cta' }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again in a minute.');
        });
      })
      .then(function () {
        msg.textContent = "You're on the list. We'll email you once, when it's ready.";
        msg.className = 'waitlist-msg ok';
        form.email.value = '';
      })
      .catch(function (err) {
        msg.textContent = err.message;
        msg.className = 'waitlist-msg err';
      })
      .finally(function () { button.disabled = false; });
  });
})();

// Header: "Sign in" becomes "Account" when a session exists
(function () {
  var link = document.getElementById('nav-account');
  if (!link) return;
  fetch('/api/auth/session', { credentials: 'same-origin' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) { if (data && data.user) link.textContent = 'Account'; })
    .catch(function () {});
})();
