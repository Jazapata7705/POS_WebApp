const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { rateLimit } = require('express-rate-limit');
const { scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
require('dotenv').config();

// Create express app
const app = express();
const port = process.env.PORT || 3000;

// Set up view engine and static files directory
app.set("view engine", "ejs");
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Create database pool
const pool = new Pool({
    user: process.env.PSQL_USER,
    host: process.env.PSQL_HOST,
    database: process.env.PSQL_DATABASE,
    password: process.env.PSQL_PASSWORD,
    port: process.env.PSQL_PORT,
    ssl: { rejectUnauthorized: false }
});

const appOrigin = process.env.APP_ORIGIN;
const sessionSecret = process.env.SESSION_SECRET;
const passwordHash = process.env.MANAGER_PASSWORD_HASH;

if (!appOrigin ||
    !/^[a-f0-9]{64}$/i.test(sessionSecret ?? '') ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(passwordHash ?? '')) {
    throw new Error('Check APP_ORIGIN, SESSION_SECRET, and MANAGER_PASSWORD_HASH in .env.');
}

const appUrl = new URL(appOrigin);
const secureCookie = appUrl.protocol === 'https:';
if (appUrl.origin !== appOrigin ||
    !['http:', 'https:'].includes(appUrl.protocol) ||
    (process.env.NODE_ENV === 'production' && !secureCookie)) {
    throw new Error('APP_ORIGIN must be the site origin. Production requires HTTPS.');
}

const [saltHex, hashHex] = passwordHash.split(':');
const salt = Buffer.from(saltHex, 'hex');
const expectedHash = Buffer.from(hashHex, 'hex');
const deriveKey = promisify(scrypt);
const managerSessionMs = 15 * 60 * 1000;
const cookieName = 'pos.manager.sid';
const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie
};

app.use('/manager', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.get('Origin') !== appOrigin) {
        return res.sendStatus(403);
    }
    next();
});

app.use('/manager', session({
    name: cookieName,
    secret: sessionSecret,
    store: new PgStore({
        pool,
        createTableIfMissing: process.env.NODE_ENV !== 'production'
    }),
    resave: false,
    saveUninitialized: false,
    cookie: { ...cookieOptions, maxAge: managerSessionMs }
}));

function hasManagerAccess(req) {
    return req.session?.managerUntil > Date.now();
}

function renderManagerLogin(res, status = 200, loginError = null) {
    return res.status(status).render('manager', {
        managerUnlocked: false,
        loginError
    });
}

app.get('/manager/login', (req, res) => {
    if (hasManagerAccess(req)) return res.redirect(303, '/manager');
    return renderManagerLogin(res);
});

const limitManagerLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    message: 'Too many sign-in attempts. Try again in 15 minutes.'
});

app.post('/manager/login', limitManagerLogin, async (req, res, next) => {
    const password = req.body?.password;
    if (typeof password !== 'string' ||
        password.length === 0 ||
        Buffer.byteLength(password, 'utf8') > 1024) {
        return renderManagerLogin(res, 400, 'Enter a valid password.');
    }

    const hash = await deriveKey(password, salt, expectedHash.length, {
        N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024
    });

    if (!timingSafeEqual(hash, expectedHash)) {
        return renderManagerLogin(res, 401, 'Incorrect password.');
    }

    req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.managerUntil = Date.now() + managerSessionMs;
        req.session.save((saveErr) => {
            if (saveErr) return next(saveErr);
            return res.redirect(303, '/manager');
        });
    });
});

app.post('/manager/logout', (req, res, next) => {
    req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie(cookieName, cookieOptions);
        return res.redirect(303, '/manager/login');
    });
});

app.use('/manager', (req, res, next) => {
    if (hasManagerAccess(req)) return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
        return res.redirect(303, '/manager/login');
    }
    return res.status(401).send('Manager sign-in required.');
});

const { registerSalesReport } = require('./sales-report');
registerSalesReport(app, pool);

// Add process hook to gracefully shutdown pool
process.on('SIGINT', function() {
    pool.end();
    console.log('Application successfully shutdown');
    process.exit(0);
});

// Routes
app.get('/', (req, res) => {
    res.render('portal', {
        vendor: process.env.VENDOR_NAME || '80s Bubble Tea',
        team: process.env.TEAM_NAME || 'Squad 80'
    });
});

app.get('/kiosk', async (req, res) => {
    try {
        const query_res = await pool.query('SELECT * FROM menuitem ORDER BY menu_item_id;');
        const items = query_res.rows;
        
        // Extract unique, non-null categories from the database items
        const categories = [...new Set(items.map(item => item.category).filter(Boolean))];
        
        const data = { 
            name: 'menu_items', 
            items: items,
            categories: categories, 
        };
        
        res.render('index', data);
    } catch (err) {
        console.error('Error executing query:', err);
        res.status(500).send('Server error retrieving menu items from database.');
    }
});

app.get('/checkout', (req, res) => {
    res.render('checkout');
});

// Add-on prices in cents; keep in sync with ADD_ONS in public/js/client.js
const ADD_ON_PRICES = {
    'boba': 50,
    'grass-jelly': 50,
    'pudding': 50,
    'aloe-vera': 50,
    'lychee-jelly': 50,
    'coconut-jelly': 50,
    'crystal-boba': 50,
    'cheese-foam': 100
};
const GUEST_CUSTOMER_ID = 0;
const DEFAULT_EMPLOYEE_ID = 1;

// Place an order: prices are recomputed from the database, not trusted from the client
app.post('/api/orders', async (req, res) => {
    const lines = req.body?.items;
    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: 'Order has no items.' });
    }

    const parsed = [];
    for (const line of lines) {
        const menuItemId = Number(line?.id);
        const quantity = Number(line?.quantity);
        const addons = Array.isArray(line?.addons) ? line.addons : [];
        if (!Number.isInteger(menuItemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99
            || !addons.every(id => Object.hasOwn(ADD_ON_PRICES, id))) {
            return res.status(400).json({ error: 'Order contains an invalid item.' });
        }
        const addonCents = [...new Set(addons)].reduce((sum, id) => sum + ADD_ON_PRICES[id], 0);
        const validSugarLevels = ['0%', '25%', '50%', '75%', '100%'];
        const validIceLevels = [
            'No ice',
            'Less ice',
            'Regular ice',
            'Extra ice'
        ];

        if (
            !validSugarLevels.includes(line.sugar) ||
            !validIceLevels.includes(line.ice) ||
            !Array.isArray(line.addons)
        ) {
            return res.status(400).json({
                error: 'Order contains invalid customization choices.'
            });
        }

        parsed.push({
            menuItemId,
            quantity,
            addonCents,
            sugar: line.sugar,
            ice: line.ice,
            addons: [...new Set(addons)]
        });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // IDs are not auto-generated, so serialize order creation while picking the next IDs
        await client.query('LOCK TABLE orders, orderdetail IN EXCLUSIVE MODE');

        const ids = [...new Set(parsed.map(line => line.menuItemId))];
        const priceRes = await client.query(
            'SELECT menu_item_id, current_price FROM menuitem WHERE menu_item_id = ANY($1) AND is_available = 1',
            [ids]
        );
        const baseCents = new Map(priceRes.rows.map(row => [row.menu_item_id, Math.round(Number(row.current_price) * 100)]));
        if (baseCents.size !== ids.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'An item in your order is no longer available.' });
        }

        const details = parsed.map(line => ({
            ...line,
            unitCents: baseCents.get(line.menuItemId) + line.addonCents
        }));
        const totalCents = details.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);

        const orderRes = await client.query(
            `INSERT INTO orders (order_id, customer_id, employee_id, total_cost)
             SELECT COALESCE(MAX(order_id), 0) + 1, $1, $2, $3 FROM orders
             RETURNING order_id`,
            [GUEST_CUSTOMER_ID, DEFAULT_EMPLOYEE_ID, totalCents / 100]
        );
        const orderId = orderRes.rows[0].order_id;

        for (const line of details) {
            await client.query(
                `INSERT INTO orderdetail (
                    order_detail_id,
                    order_id,
                    menu_item_id,
                    quantity,
                    unit_price,
                    sugar_level,
                    ice_level,
                    addons
                )
                SELECT
                    COALESCE(MAX(order_detail_id), 0) + 1,
                    $1, $2, $3, $4, $5, $6, $7::jsonb
                FROM orderdetail`,
                [
                    orderId,
                    line.menuItemId,
                    line.quantity,
                    line.unitCents / 100,
                    line.sugar,
                    line.ice,
                    JSON.stringify(line.addons)
                ]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ orderId, totalCents });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error placing order:', err);
        res.status(500).json({ error: 'Could not place your order. Please try again.' });
    } finally {
        client.release();
    }
});

// Recent Orders Page
app.get('/orders', async (req, res) => {
    try {
        const query_res = await pool.query(
            `SELECT o.order_id, o.total_cost,
                    to_char(o.order_timestamp, 'Mon FMDD, YYYY FMHH12:MI AM') AS placed_at,
                    json_agg(json_build_object(
                        'name', m.name,
                        'quantity', d.quantity,
                        'unit_price', d.unit_price
                    ) ORDER BY d.order_detail_id) AS items
             FROM (SELECT * FROM orders ORDER BY order_id DESC LIMIT 25) o
             JOIN orderdetail d ON d.order_id = o.order_id
             JOIN menuitem m ON m.menu_item_id = d.menu_item_id
             GROUP BY o.order_id, o.order_timestamp, o.total_cost
             ORDER BY o.order_id DESC;`
        );

        res.render('orders', { orders: query_res.rows });
    } catch (err) {
        console.error('Error executing query:', err);
        res.status(500).send('Server error retrieving orders from database.');
    }
});

// Manager Menu Page
app.get('/manager', async (req, res) => {
    try {
        const query_res = await pool.query('SELECT * FROM menuitem ORDER BY category, menu_item_id;');
        res.render('manager', {
            managerUnlocked: true,
            items: query_res.rows,
            savedId: Number(req.query.saved) || null,
            errorId: Number(req.query.error) || null
        });
    } catch (err) {
        console.error('Error executing query:', err);
        res.status(500).send('Server error retrieving menu items from database.');
    }
});
// Add a new menu item
app.post('/manager/items/add', async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    const category = String(req.body.category ?? '').trim();
    const priceText = String(req.body.price ?? '');
    const price = Number(priceText);
    const isAvailable = req.body.is_available === 'on' ? 1 : 0;

    if (
        !name ||
        !category ||
        !/^\d{1,3}(\.\d{1,2})?$/.test(priceText) ||
        price > 100
    ) {
        return res.status(400).send('Invalid drink information.');
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query('LOCK TABLE menuitem IN EXCLUSIVE MODE');

        await client.query(
            `INSERT INTO menuitem
                (menu_item_id, name, category, current_price, is_available)
             SELECT
                COALESCE(MAX(menu_item_id), 0) + 1,
                $1, $2, $3, $4
             FROM menuitem`,
            [name, category, price, isAvailable]
        );

        await client.query('COMMIT');

        res.redirect('/manager');

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error adding menu item:', err);
        res.status(500).send('Server error adding menu item.');
    } finally {
        client.release();
    }
});
// Update a menu item's price and availability
app.post('/manager/items/:id', async (req, res) => {
    const menuItemId = Number(req.params.id);
    const price = Number(req.body.price);
    const isAvailable = req.body.is_available === 'on' ? 1 : 0;

    if (!Number.isInteger(menuItemId)) {
        return res.status(400).send('Invalid menu item.');
    }
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(req.body.price ?? '') || price > 100) {
        return res.redirect(`/manager?error=${menuItemId}#item-${menuItemId}`);
    }

    try {
        await pool.query(
            'UPDATE menuitem SET current_price = $1, is_available = $2 WHERE menu_item_id = $3;',
            [price, isAvailable, menuItemId]
        );
        res.redirect(`/manager?saved=${menuItemId}#item-${menuItemId}`);
    } catch (err) {
        console.error('Error updating menu item:', err);
        res.status(500).send('Server error updating menu item.');
    }
});

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
});
