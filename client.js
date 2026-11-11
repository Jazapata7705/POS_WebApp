const CART_KEY = 'drink-cart-v1';
const CONFIRMED_ORDER_KEY = 'drink-confirmed-order-v1';
const ADD_ONS = [
    { id: 'boba', label: 'Boba', priceCents: 50 },
    { id: 'grass-jelly', label: 'Grass jelly', priceCents: 50 },
    { id: 'pudding', label: 'Pudding', priceCents: 50 },
    { id: 'aloe-vera', label: 'Aloe vera', priceCents: 50 },
    { id: 'lychee-jelly', label: 'Lychee jelly', priceCents: 50 },
    { id: 'coconut-jelly', label: 'Coconut jelly', priceCents: 50 },
    { id: 'crystal-boba', label: 'Crystal boba', priceCents: 50 },
    { id: 'cheese-foam', label: 'Cheese foam', priceCents: 100 }
];
const ADD_ONS_BY_ID = new Map(ADD_ONS.map(addon => [addon.id, addon]));
let cartStorageUnavailable = false;

document.addEventListener('DOMContentLoaded', () => {
    setupKioskAccessibility();
    setupKioskContrast();
    const cart = readCart();

    if (document.body.dataset.page === 'menu') {
        setupMenu(cart);
    }

    if (document.body.dataset.page === 'checkout') {
        const confirmedOrder = readConfirmedOrder();
        const checkoutItems = confirmedOrder ? confirmedOrder.items : cart;
        renderCheckout(checkoutItems, confirmedOrder);
        updateCartBadge(confirmedOrder ? [] : cart);
    }
});

function readCart() {
    let saved;
    try {
        saved = sessionStorage.getItem(CART_KEY);
        cartStorageUnavailable = false;
    } catch {
        cartStorageUnavailable = true;
        return [];
    }

    if (!saved) return [];

    try {
        const stored = JSON.parse(saved);
        if (!Array.isArray(stored)) return [];

        return normalizeCart(stored);
    } catch {
        return [];
    }
}

function normalizeCart(stored) {
    if (!Array.isArray(stored)) return [];

    return stored.filter(line =>
        line &&
        typeof line.id === 'string' &&
        typeof line.name === 'string' &&
        Number.isInteger(line.baseCents) &&
        line.baseCents >= 0 &&
        Number.isInteger(line.quantity) &&
        line.quantity > 0 &&
        typeof line.sugar === 'string' &&
        typeof line.ice === 'string' &&
        Array.isArray(line.addons)
    ).map(line => ({
        ...line,
        addons: [...new Set(line.addons.filter(id => ADD_ONS_BY_ID.has(id)))]
    }));
}

function readConfirmedOrder() {
    let saved;
    try {
        saved = sessionStorage.getItem(CONFIRMED_ORDER_KEY);
    } catch {
        cartStorageUnavailable = true;
        return null;
    }

    if (!saved) return null;

    try {
        const order = JSON.parse(saved);
        const items = normalizeCart(order?.items);
        if (items.length === 0) return null;
        return { items, orderId: order.orderId ?? null };
    } catch {
        return null;
    }
}

function saveCart(cart) {
    try {
        sessionStorage.setItem(CART_KEY, JSON.stringify(cart));
        sessionStorage.removeItem(CONFIRMED_ORDER_KEY);
        cartStorageUnavailable = false;
        return true;
    } catch {
        cartStorageUnavailable = true;
        return false;
    }
}

function saveConfirmedOrder(cart, orderId) {
    try {
        sessionStorage.setItem(CONFIRMED_ORDER_KEY, JSON.stringify({
            items: cart,
            orderId
        }));
        sessionStorage.removeItem(CART_KEY);
        cartStorageUnavailable = false;
        return true;
    } catch {
        try {
            sessionStorage.removeItem(CONFIRMED_ORDER_KEY);
        } catch {
            // Keep the confirmation attempt failed if session storage is unavailable.
        }
        cartStorageUnavailable = true;
        return false;
    }
}

function formatMoney(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(cents / 100);
}

function addonsTotalCents(addonIds) {
    return addonIds.reduce((sum, id) => sum + (ADD_ONS_BY_ID.get(id)?.priceCents || 0), 0);
}

function configuredPriceCents(line) {
    return line.baseCents + addonsTotalCents(line.addons);
}

function configurationKey(line) {
    return JSON.stringify([
        line.id,
        line.sugar,
        line.ice,
        [...line.addons].sort()
    ]);
}

function setupMenu(cart) {
    const categoryView = document.getElementById('category-view');
    const categoryButtons = Array.from(document.querySelectorAll('.category-card'));
    const categoryTabs = Array.from(document.querySelectorAll('.category-tab'));
    const categoryNav = document.getElementById('menu-category-nav');
    const menuViews = Array.from(document.querySelectorAll('[data-category-view]'));
    const cartItemsList = document.getElementById('cart-items-list');
    const cartTotal = document.getElementById('cart-total-price');
    const dialog = document.getElementById('customization-dialog');
    const form = document.getElementById('customization-form');
    const storageError = document.getElementById('cart-storage-error');
    let selectedDrink = null;
    let lastCategoryButton = null;

    function showCategory(category, sourceButton) {
        const view = menuViews.find(section => section.dataset.categoryView === category);
        if (!view) return;

        if (sourceButton?.classList.contains('category-card')) lastCategoryButton = sourceButton;
        categoryView.hidden = true;
        categoryNav.hidden = false;
        menuViews.forEach(section => { section.hidden = section !== view; });
        categoryTabs.forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.category === category));
        });
        view.querySelector('h1')?.focus();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    categoryButtons.forEach(button => {
        button.addEventListener('click', () => showCategory(button.dataset.category, button));
    });
    categoryTabs.forEach(button => {
        button.addEventListener('click', () => showCategory(button.dataset.category, button));
    });

    document.querySelectorAll('.back-to-categories').forEach(button => {
        button.addEventListener('click', () => {
            menuViews.forEach(section => { section.hidden = true; });
            categoryNav.hidden = true;
            categoryView.hidden = false;
            lastCategoryButton?.focus();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });

    document.querySelectorAll('.item-card').forEach(card => {
        card.addEventListener('click', () => {
            if (card.classList.contains('sold-out')) return;
            selectedDrink = {
                id: card.dataset.itemId,
                name: card.dataset.itemName,
                baseCents: Number(card.dataset.baseCents) || 0,
                artId: card.dataset.itemArt
            };

            form.reset();
            document.getElementById('dialog-item-name').textContent = selectedDrink.name;
            document.getElementById('dialog-art').setAttribute('aria-label', `${selectedDrink.name} illustration`);
            document.getElementById('dialog-art-use').setAttribute('href', `/images/menu-drinks.svg#${selectedDrink.artId}`);
            document.getElementById('dialog-base-price').textContent = formatMoney(selectedDrink.baseCents);
            updateDialogPrice();
            dialog.showModal();
        });
    });

    document.getElementById('close-customization').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
    });
    form.addEventListener('change', updateDialogPrice);

    form.addEventListener('submit', event => {
        event.preventDefault();
        if (!selectedDrink) return;

        const line = {
            id: selectedDrink.id,
            name: selectedDrink.name,
            baseCents: selectedDrink.baseCents,
            sugar: document.getElementById('sugar-level').value,
            ice: document.getElementById('ice-level').value,
            addons: Array.from(form.querySelectorAll('input[name="addons"]:checked'), input => input.value).sort(),
            quantity: 1
        };
        const nextCart = cart.map(item => ({ ...item, addons: [...item.addons] }));
        const key = configurationKey(line);
        const existingLine = nextCart.find(item => configurationKey(item) === key);

        if (existingLine) {
            existingLine.quantity += 1;
        } else {
            nextCart.push(line);
        }

        if (!saveCart(nextCart)) {
            storageError.hidden = false;
            return;
        }

        cart.splice(0, cart.length, ...nextCart);
        storageError.hidden = true;
        renderMenuCart(cartItemsList, cartTotal, cart, changeQuantity);
        updateCartBadge(cart);
        dialog.close();
    });

    function changeQuantity(index, delta, buttonIndex) {
        const next = cart.map(line => ({
            ...line, 
            addons: [...line.addons]
        }));

        next[index].quantity += delta;
        const removed = next[index].quantity <= 0;
        if (removed) {
            next.splice(index, 1);
        }
        
        const error = document.getElementById('menu-cart-error');
        if (!saveCart(next)) {
            error.hidden = false;
            return;
        }
        error.hidden = true;
        cart.splice(0, cart.length, ...next);

        renderMenuCart(cartItemsList, cartTotal, cart, changeQuantity);
        updateCartBadge(cart);

        const rows = cartItemsList.querySelectorAll('.cart-item-row');
        const targetRow = rows[Math.min(index, rows.length - 1)];
        const targetButton = targetRow?.querySelectorAll('button')[removed ? 0 : buttonIndex];

        (targetButton ?? document.getElementById('cart-heading'))?.focus();
    }

    function updateDialogPrice() {
        if (!selectedDrink) return;
        const checkedAddons = Array.from(form.querySelectorAll('input[name="addons"]:checked'), input => input.value);
        document.getElementById('dialog-total-price').textContent = formatMoney(
            selectedDrink.baseCents + addonsTotalCents(checkedAddons)
        );
    }

    renderMenuCart(cartItemsList, cartTotal, cart, changeQuantity);
    updateCartBadge(cart);
}

function updateCartBadge(cart) {
    const badge = document.getElementById('cart-count');
    if (!badge) return;

    const quantity = cart.reduce((sum, line) => sum + line.quantity, 0);
    badge.textContent = String(quantity);
    badge.setAttribute('aria-label', `${quantity} ${quantity === 1 ? 'item' : 'items'} in order`);
}

function renderMenuCart(list, total, cart, changeQuantity) {
    if (!list || !total) return;
    list.replaceChildren();

    if (cart.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty-cart-msg';
        empty.textContent = 'Your order is empty.';
        list.append(empty);
        total.textContent = '$0.00';
        return;
    }

    let totalCents = 0;
    cart.forEach((line, index) => {
        const lineTotal = configuredPriceCents(line) * line.quantity;
        totalCents += lineTotal;

        const row = document.createElement('li');
        row.className = 'cart-item-row';

        const details = document.createElement('span');
        details.className = 'cart-item-name';
        const name = document.createElement('span');
        name.textContent = `${line.name} ×${line.quantity}`;
        details.append(name);

        const customizations = document.createElement('span');
        customizations.className = 'cart-item-customizations';
        const addonLabels = line.addons.map(id => ADD_ONS_BY_ID.get(id)?.label).filter(Boolean);
        customizations.textContent = [line.sugar, line.ice, ...addonLabels].join(' · ');
        details.append(customizations);

        const price = document.createElement('span');
        price.textContent = formatMoney(lineTotal);
        const controls = document.createElement('div');
        controls.className = 'quantity-controls';

        [
            ['-', -1, 'Decrease quantity of'],
            ['+', 1, 'Increase quantity of'],
            ['Remove', -line.quantity, 'Remove']
        ].forEach(([label, delta, action], buttonIndex) =>  {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;

            button.setAttribute(
                'aria-label',
                `${action} ${line.name}, ${line.sugar}, ${line.ice}, ${line.addons.join(', ') || 'no add-ons'}`
            );

            button.addEventListener('click', () => changeQuantity(index, delta, buttonIndex));
            controls.append(button);

            details.append(controls);
            row.append(details, price);
            list.append(row);
        });

        details.append(controls);
        row.append(details, price);
        list.append(row);
    });

    total.textContent = formatMoney(totalCents);
}

function renderCheckout(cart, confirmedOrder = null) {
    const confirmed = Boolean(confirmedOrder);
    const itemsContainer = document.getElementById('checkout-items');
    const emptyState = document.getElementById('checkout-empty');
    const totalRow = document.getElementById('checkout-total');
    const totalPrice = document.getElementById('checkout-total-price');
    const storageError = document.getElementById('checkout-storage-error');
    const confirmation = document.getElementById('order-confirmation');
    const eyebrow = document.getElementById('checkout-eyebrow');
    const heading = document.getElementById('checkout-heading');
    const actions = document.getElementById('checkout-actions');
    const confirmButton = document.getElementById('confirm-order-btn');
    const startNewOrder = document.getElementById('start-new-order');
    const orderNumber = document.getElementById('order-number');
    if (!itemsContainer || !emptyState || !totalRow || !totalPrice) return;

    itemsContainer.replaceChildren();
    emptyState.hidden = cart.length > 0;
    itemsContainer.hidden = cart.length === 0;
    totalRow.hidden = cart.length === 0;
    if (confirmation) confirmation.hidden = !confirmed;
    if (orderNumber) orderNumber.textContent = confirmedOrder?.orderId ? `#${confirmedOrder.orderId}` : '';
    if (eyebrow) eyebrow.textContent = confirmed ? 'Receipt' : 'Almost ready';
    if (heading) heading.textContent = confirmed ? 'Your receipt' : 'Review your order';
    if (actions) actions.hidden = cart.length === 0;
    if (confirmButton) confirmButton.hidden = confirmed || cart.length === 0;
    if (startNewOrder) startNewOrder.hidden = !confirmed;
    if (storageError) storageError.hidden = !cartStorageUnavailable;

    let orderTotalCents = 0;
    cart.forEach(line => {
        const addonTotal = addonsTotalCents(line.addons);
        const perDrinkTotal = line.baseCents + addonTotal;
        const lineTotal = perDrinkTotal * line.quantity;
        orderTotalCents += lineTotal;

        const article = document.createElement('article');
        article.className = 'checkout-item';

        const details = document.createElement('div');
        const heading = document.createElement('div');
        heading.className = 'checkout-item-heading';
        const name = document.createElement('h2');
        name.textContent = line.name;
        const quantity = document.createElement('span');
        quantity.className = 'checkout-quantity';
        quantity.textContent = `Quantity: ${line.quantity}`;
        heading.append(name, quantity);

        const choices = document.createElement('ul');
        choices.className = 'checkout-customizations';
        appendChoice(choices, `Sugar: ${line.sugar} · Free`);
        appendChoice(choices, `Ice: ${line.ice} · Free`);
        line.addons.forEach(id => {
            const addon = ADD_ONS_BY_ID.get(id);
            if (addon) appendChoice(choices, `${addon.label} · +${formatMoney(addon.priceCents)}`);
        });

        const breakdown = document.createElement('div');
        breakdown.className = 'price-breakdown';
        appendBreakdown(breakdown, 'Base price', formatMoney(line.baseCents));
        appendBreakdown(breakdown, 'Add-ons per drink', formatMoney(addonTotal));
        appendBreakdown(breakdown, 'Price per drink', formatMoney(perDrinkTotal));
        details.append(heading, choices, breakdown);

        const linePrice = document.createElement('div');
        linePrice.className = 'checkout-line-total';
        const linePriceLabel = document.createElement('span');
        linePriceLabel.textContent = 'Line total';
        const linePriceAmount = document.createElement('strong');
        linePriceAmount.textContent = formatMoney(lineTotal);
        linePrice.append(linePriceLabel, linePriceAmount);
        article.append(details, linePrice);
        itemsContainer.append(article);
    });

    totalPrice.textContent = formatMoney(orderTotalCents);

    confirmButton?.addEventListener('click', async () => {
        if (cart.length === 0 || confirmButton.disabled) return;
        confirmButton.disabled = true;
        confirmButton.textContent = 'Placing order…';

        let orderId;
        try {
            const response = await fetch('/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: cart })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'Could not place your order. Please try again.');
            orderId = result.orderId;
        } catch (err) {
            confirmButton.disabled = false;
            confirmButton.textContent = 'Confirm order';
            if (storageError) {
                storageError.textContent = err instanceof TypeError
                    ? 'Could not reach the server. Check your connection and try again.'
                    : err.message;
                storageError.hidden = false;
            }
            return;
        }

        // The order is saved on the server even if the browser cannot store the receipt
        saveConfirmedOrder(cart, orderId);
        if (storageError) storageError.hidden = true;
        if (orderNumber) orderNumber.textContent = `#${orderId}`;
        if (confirmation) confirmation.hidden = false;
        if (eyebrow) eyebrow.textContent = 'Receipt';
        if (heading) heading.textContent = 'Your receipt';
        confirmButton.hidden = true;
        if (startNewOrder) startNewOrder.hidden = false;
        updateCartBadge([]);
        heading?.focus();
    });

    startNewOrder?.addEventListener('click', event => {
        event.preventDefault();
        try {
            sessionStorage.removeItem(CART_KEY);
            sessionStorage.removeItem(CONFIRMED_ORDER_KEY);
            window.location.assign(startNewOrder.href);
        } catch {
            if (storageError) {
                storageError.textContent = 'Your browser could not reset this demo order. Allow storage for this site, then try again.';
                storageError.hidden = false;
            }
        }
    });
}

function appendChoice(list, text) {
    const item = document.createElement('li');
    item.textContent = text;
    list.append(item);
}

function appendBreakdown(container, label, amount) {
    const row = document.createElement('div');
    row.className = 'price-breakdown-row';
    const name = document.createElement('span');
    name.textContent = label;
    const price = document.createElement('strong');
    price.textContent = amount;
    row.append(name, price);
    container.append(row);
}

function setupKioskAccessibility() {
    const key = 'kiosk-text-size';
    const sizes = [100, 125, 150, 175, 200];
    const controls = document.querySelector('.kiosk-text-controls');
    if (!controls) return;
    const status = controls.querySelector('output');
    const decrease = controls.querySelector('[data-text-change="-1"]');
    const increase = controls.querySelector('[data-text-change="1"]');
    let size = 100;

    function render() {
        document.documentElement.style.fontSize = `${size}%`;
        document.documentElement.dataset.kioskTextSize = size;
        status.value = `${size}%`;
        decrease.setAttribute('aria-disabled', String(size === sizes[0]));
        increase.setAttribute('aria-disabled', String(size === sizes.at(-1)));
    }

    function restore() {
        try {
            const saved = Number(localStorage.getItem(key));
            size = sizes.includes(saved) ? saved : sizes[0];
        } catch {
            // Keep the current size if browser storage is unavailable.
        }
        render();
    }

    for (const button of [decrease, increase]) {
        button.addEventListener('click', () => {
            const next = sizes[sizes.indexOf(size) + Number(button.dataset.textChange)];
            if (next === undefined) return;

            size = next;
            render();

            try {
                localStorage.setItem(key, String(size));
            } catch {
                // Text resizing still works on this page without storage.
            }
        });
    }

    restore();
    controls.hidden = false;
    window.addEventListener('pageshow', event => {
        if (event.persisted) restore();
    });
}

function setupKioskContrast() {
    const button = document.getElementById('kiosk-high-contrast');
    if (!button) return;

    const storageKey = 'kiosk-high-contrast';
    const root = document.documentElement;

    function applyContrast(enabled) {
        root.toggleAttribute('data-kiosk-high-contrast', enabled);
        button.textContent = enabled ? 'Low contrast' : 'High contrast';
    }

    function restoreContrast() {
        try {
            applyContrast(localStorage.getItem(storageKey) === 'true');
        } catch {
            // Keep the current setting if browser storage is unavailable.
        }
    }

    button.addEventListener('click', () => {
        const enabled = !root.hasAttribute('data-kiosk-high-contrast');
        applyContrast(enabled);

        try {
            localStorage.setItem(storageKey, String(enabled));
        } catch {
            // The toggle still works on the current page.
        }
    });

    restoreContrast();

    window.addEventListener('pageshow', event => {
        if (event.persisted) restoreContrast();
    });
}