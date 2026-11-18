(() => {
    const toggle = document.getElementById('cashier-accessibility-toggle');
    const panel = document.getElementById('cashier-accessibility-panel');
    const decrease = document.getElementById('cashier-text-decrease');
    const increase = document.getElementById('cashier-text-increase');
    const sizeLabel = document.getElementById('cashier-text-size');
    const contrastToggle = document.getElementById('cashier-contrast-toggle');
    if (!toggle || !panel || !decrease || !increase || !sizeLabel || !contrastToggle) return;

    const root = document.documentElement;
    const sizes = [100, 125, 150, 175, 200];
    let size = 100;
    let highContrast = false;

    function renderTextSize() {
        root.style.fontSize = `${size}%`;
        root.dataset.cashierTextSize = String(size);
        sizeLabel.value = `${size}%`;
        decrease.disabled = size === sizes[0];
        increase.disabled = size === sizes.at(-1);
    }

    function setPanelOpen(open) {
        panel.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            panel.querySelector('button:not(:disabled)')?.focus();
        } else {
            toggle.focus();
        }
    }

    toggle.addEventListener('click', () => setPanelOpen(panel.hidden));
    decrease.addEventListener('click', () => {
        const nextSize = sizes[sizes.indexOf(size) - 1];
        if (nextSize === undefined) return;
        size = nextSize;
        renderTextSize();
    });
    increase.addEventListener('click', () => {
        const nextSize = sizes[sizes.indexOf(size) + 1];
        if (nextSize === undefined) return;
        size = nextSize;
        renderTextSize();
    });
    contrastToggle.addEventListener('click', () => {
        highContrast = !highContrast;
        root.toggleAttribute('data-cashier-high-contrast', highContrast);
        contrastToggle.setAttribute('aria-pressed', String(highContrast));
        contrastToggle.textContent = highContrast ? 'High contrast on' : 'High contrast';
    });

    window.addEventListener('pagehide', () => {
        size = 100;
        highContrast = false;
        renderTextSize();
        root.removeAttribute('data-cashier-high-contrast');
        contrastToggle.setAttribute('aria-pressed', 'false');
        contrastToggle.textContent = 'High contrast';
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !panel.hidden) {
            event.preventDefault();
            setPanelOpen(false);
        }
    });
})();
