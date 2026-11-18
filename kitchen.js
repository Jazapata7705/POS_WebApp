const POLL_MS = 5000;
const WARN_MINUTES = 5;
const LATE_MINUTES = 10;
const NEW_SECONDS = 30;
const SOUND_KEY = 'kitchen-sound-v1';

const board = document.getElementById('kitchen-board');
const empty = document.getElementById('kitchen-empty');
const count = document.getElementById('kitchen-count');
const status = document.getElementById('kitchen-status');
const undo = document.getElementById('kitchen-undo');
const soundButton = document.getElementById('kitchen-sound');
const recentList = document.getElementById('kitchen-recent-list');
const recentCount = document.getElementById('kitchen-recent-count');

let lastDoneId = null;
let knownIds = null; // null until the first load, so existing orders don't beep
let audio = null;
let soundOn = true;
try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* storage blocked: keep default */ }

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(className, text, key, onClick) {
    const node = el('button', className, text);
    node.type = 'button';
    node.dataset.key = key; // lets focus survive the re-render on each poll
    node.addEventListener('click', onClick);
    return node;
}

function showError(message) {
    status.textContent = message;
    status.classList.add('kitchen-status-error');
}

// Session expired: the server redirects GETs and rejects POSTs with 401
function needsSignIn(res) {
    if (!res.redirected && res.status !== 401) return false;
    location.assign('/kitchen/login');
    return true;
}

// Browsers only allow audio after a tap, so the context starts on the first one
document.addEventListener('pointerdown', () => {
    audio ??= new AudioContext();
    audio.resume();
});

function beep() {
    if (!soundOn || !audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.25);
}

function renderSound() {
    soundButton.textContent = soundOn ? 'Sound on' : 'Sound off';
    soundButton.setAttribute('aria-pressed', String(soundOn));
}

soundButton.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* not remembered, still works */ }
    renderSound();
});

function renderTicket(order) {
    const minutes = Math.max(0, Math.floor(order.age_seconds / 60));
    const ticket = el('li', 'kitchen-ticket');
    if (minutes >= LATE_MINUTES) ticket.dataset.age = 'late';
    else if (minutes >= WARN_MINUTES) ticket.dataset.age = 'warn';
    if (order.age_seconds < NEW_SECONDS) ticket.classList.add('kitchen-new');
    if (order.started) ticket.classList.add('kitchen-started');

    const head = el('div', 'kitchen-ticket-head');
    const title = el('h2', '', `#${order.order_id}`);
    if (order.age_seconds < NEW_SECONDS) title.append(el('span', 'kitchen-badge', 'NEW'));
    if (order.started) title.append(el('span', 'kitchen-badge kitchen-badge-progress', 'In progress'));
    head.append(title, el('span', 'kitchen-age', `${minutes} min`));

    const doneCount = order.items.filter(item => item.done).length;
    const progress = el('p', 'kitchen-progress', `${doneCount}/${order.items.length} drinks done`);

    const items = el('ul', 'kitchen-items');
    for (const item of order.items) {
        const mods = [item.sugar && `${item.sugar} sugar`, item.ice, ...(item.addons || []).map(id => id.replaceAll('-', ' '))]
            .filter(Boolean);
        const toggle = button('kitchen-item', '', `item-${item.id}`, () => act(`/kitchen/items/${item.id}/toggle`, toggle));
        toggle.setAttribute('aria-pressed', String(item.done));
        toggle.append(el('strong', 'kitchen-qty', `${item.quantity}×`), ` ${item.name}`);
        if (mods.length) toggle.append(el('span', 'kitchen-mods', mods.join(' · ')));
        const row = el('li');
        row.append(toggle);
        items.append(row);
    }

    const actions = el('div', 'kitchen-actions');
    if (!order.started) {
        actions.append(button('kitchen-start', 'Start', `start-${order.order_id}`,
            event => act(`/kitchen/orders/${order.order_id}/start`, event.currentTarget)));
    }
    const done = button('kitchen-done', 'Done', `done-${order.order_id}`, () => complete(order.order_id, ticket, done));
    done.setAttribute('aria-label', `Mark order ${order.order_id} done`);
    actions.append(done);

    ticket.append(head, progress, items, actions);
    return ticket;
}

function renderRecent(order) {
    const row = el('li', 'kitchen-recent-row');
    const minutes = Math.floor(order.done_seconds_ago / 60);
    const text = el('span', '', `#${order.order_id} · ${order.summary}`);
    text.append(el('span', 'kitchen-mods', minutes < 1 ? 'just now' : `${minutes} min ago`));
    row.append(text, button('kitchen-signout', 'Recall', `recall-${order.order_id}`,
        event => act(`/kitchen/orders/${order.order_id}/reopen`, event.currentTarget)));
    return row;
}

async function load() {
    try {
        const res = await fetch('/kitchen/orders', { headers: { Accept: 'application/json' } });
        if (needsSignIn(res)) return;
        if (!res.ok) return showError(`Server error (${res.status}). Check the server log. Retrying…`);
        const { open, recent } = await res.json();

        const ids = new Set(open.map(order => order.order_id));
        if (knownIds && open.some(order => !knownIds.has(order.order_id))) beep();
        knownIds = ids;

        const focusedKey = document.activeElement?.dataset?.key;
        board.replaceChildren(...open.map(renderTicket));
        recentList.replaceChildren(...recent.map(renderRecent));
        if (focusedKey) document.querySelector(`[data-key="${focusedKey}"]`)?.focus();

        count.textContent = open.length;
        recentCount.textContent = recent.length;
        empty.hidden = open.length > 0;
        status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        status.classList.remove('kitchen-status-error');
    } catch {
        showError('Connection lost. Retrying…');
    }
}

async function post(path) {
    const res = await fetch(path, { method: 'POST' });
    if (needsSignIn(res)) return null;
    return res;
}

// Start, drink toggle, and recall: send, then redraw from the server
async function act(path, control) {
    const key = control.dataset.key;
    control.disabled = true;
    try {
        const res = await post(path);
        if (!res) return;
        // 404 means another screen already changed it; the reload shows the current state
        if (!res.ok && res.status !== 404) throw new Error(res.status);
        await load();
        // The disabled button lost focus; return it to the redrawn one
        if (key) document.querySelector(`[data-key="${key}"]`)?.focus();
    } catch {
        control.disabled = false;
        showError('That change did not save. Try again.');
    }
}

async function complete(orderId, ticket, doneButton) {
    doneButton.disabled = true;
    try {
        const res = await post(`/kitchen/orders/${orderId}/complete`);
        if (!res) return;
        if (!res.ok && res.status !== 404) throw new Error(res.status);
        ticket.remove();
        count.textContent = board.children.length;
        empty.hidden = board.children.length > 0;
        lastDoneId = orderId;
        undo.textContent = `Undo #${orderId}`;
        undo.hidden = false;
        load();
    } catch {
        doneButton.disabled = false;
        showError(`Could not mark #${orderId} done. Try again.`);
    }
}

undo.addEventListener('click', async () => {
    if (lastDoneId === null) return;
    await act(`/kitchen/orders/${lastDoneId}/reopen`, undo);
    if (!undo.disabled) return; // act re-enables only on failure
    undo.hidden = true;
    undo.disabled = false;
    lastDoneId = null;
});

renderSound();
load();
setInterval(load, POLL_MS);
