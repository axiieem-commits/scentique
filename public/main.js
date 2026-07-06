/* ===== SCENTIQUE — SHARED JS ===== */

/* ── CART STORE ── */
const Cart = {
  get() {
    const items = JSON.parse(localStorage.getItem('scentique_cart') || '[]');
    return items.map(item => ({
      ...item,
      qty: Number(item.qty ?? item.quantity ?? 1),
      img: item.img || item.image || ''
    }));
  },
  save(items) {
    localStorage.setItem('scentique_cart', JSON.stringify(items));
    Cart.syncBadge();
  },
  add(product) {
    const items = Cart.get();
    const idx = items.findIndex(i => String(i.id) === String(product.id));
    if (idx > -1) {
      items[idx].qty += 1;
    } else {
      items.push({ ...product, qty: 1 });
    }
    Cart.save(items);
    Toast.show(`${product.name} added to cart ✓`, 'success');
  },
  remove(id) {
    const items = Cart.get().filter(i => String(i.id) !== String(id));
    Cart.save(items);
  },
  updateQty(id, qty) {
    const items = Cart.get();
    const idx = items.findIndex(i => String(i.id) === String(id));
    if (idx > -1) {
      if (qty <= 0) {
        items.splice(idx, 1);
      } else {
        items[idx].qty = qty;
      }
    }
    Cart.save(items);
  },
  count() {
    return Cart.get().reduce((s, i) => s + i.qty, 0);
  },
  total() {
    return Cart.get().reduce((s, i) => s + i.price * i.qty, 0);
  },
  syncBadge() {
    const badges = document.querySelectorAll('.cart-badge');
    const count = Cart.count();
    badges.forEach(b => {
      b.textContent = count > 9 ? '9+' : count;
      b.classList.toggle('show', count > 0);
    });
  }
};

/* ── AUTH STORE ── */
const Auth = {
  register(username, email, password) {
    const normalizedUsername = String(username || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim())) {
      return { ok: false, msg: 'Please enter a valid email address.' };
    }

    const users = JSON.parse(localStorage.getItem('scentique_users') || '[]');
    if (users.find(u => String(u.email || '').toLowerCase() === normalizedEmail)) {
      return { ok: false, msg: 'Email already registered.' };
    }
    if (users.find(u => String(u.username || '').toLowerCase() === normalizedUsername.toLowerCase())) {
      return { ok: false, msg: 'Username already taken.' };
    }

    users.push({ username: normalizedUsername, email: normalizedEmail, password });
    localStorage.setItem('scentique_users', JSON.stringify(users));
    return { ok: true };
  },
  login(username, password) {
    const users = JSON.parse(localStorage.getItem('scentique_users') || '[]');
    const user = users.find(u => (u.username === username || u.email === username) && u.password === password);
    if (!user) return { ok: false, msg: 'Invalid username or password.' };
    localStorage.setItem('scentique_session', JSON.stringify(user));
    return { ok: true, user };
  },
  logout() {
    localStorage.removeItem('scentique_session');
    window.location.href = './';
  },
  current() {
    return JSON.parse(localStorage.getItem('scentique_session') || 'null');
  },
  update(data) {
    const session = Auth.current();
    if (!session) return;
    const users = JSON.parse(localStorage.getItem('scentique_users') || '[]');
    const idx = users.findIndex(u => u.email === session.email);
    if (idx > -1) {
      Object.assign(users[idx], data);
      localStorage.setItem('scentique_users', JSON.stringify(users));
    }
    Object.assign(session, data);
    localStorage.setItem('scentique_session', JSON.stringify(session));
  }
};

/* ── TOAST ── */
const Toast = {
  el: null,
  timer: null,
  init() {
    if (document.getElementById('toast')) return;
    const t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    t.innerHTML = '<span id="toast-msg"></span>';
    document.body.appendChild(t);
    Toast.el = t;
  },
  show(msg, type = 'success') {
    if (!Toast.el) Toast.init();
    const el = document.getElementById('toast');
    el.querySelector('#toast-msg').textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(Toast.timer);
    Toast.timer = setTimeout(() => { el.classList.remove('show'); }, 3000);
  }
};

/* ── SEARCH OVERLAY ── */
function initSearch() {
  const overlay = document.getElementById('searchOverlay');
  const closeBtn = document.getElementById('searchClose');
  const input = document.getElementById('searchInput');
  if (!overlay) return;
  document.querySelectorAll('.open-search').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      overlay.classList.add('open');
      setTimeout(() => input && input.focus(), 100);
    });
  });
  if (closeBtn) closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && input.value.trim()) {
        window.location.href = `shop.html?q=${encodeURIComponent(input.value.trim())}`;
      }
    });
  }
}

/* ── NAVBAR SCROLL ── */
function initNavScroll(solidAtTop = false) {
  const nav = document.querySelector('.navbar');
  if (!nav) return;
  const check = () => {
    if (solidAtTop || window.scrollY > 20) {
      nav.classList.add('solid');
    } else {
      nav.classList.remove('solid');
    }
  };
  window.addEventListener('scroll', check, { passive: true });
  check();
}

/* ── RENDER STARS ── */
function renderStars(rating) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star${i > rating ? ' empty' : ''}">★</span>`;
  }
  return `<div class="stars">${html}</div>`;
}

/* ── MODAL HELPERS ── */
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}

/* ── INIT ON LOAD ── */
document.addEventListener('DOMContentLoaded', () => {
  Toast.init();
  Cart.syncBadge();
  initSearch();

  // close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) m.classList.remove('open');
    });
  });
});
