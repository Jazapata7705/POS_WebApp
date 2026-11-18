const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { rateLimit } = require('express-rate-limit');
const { scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { registerCustomerApi } = require('./customer-api');
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
const passwordHashPattern = /^[a-f0-9]{32}:[a-f0-9]{128}$/i;

if (!appOrigin ||
    !/^[a-f0-9]{64}$/i.test(sessionSecret ?? '') ||
    !passwordHashPattern.test(process.env.MANAGER_PASSWORD_HASH ?? '') ||
    !passwordHashPattern.test(process.env.KITCHEN_PASSWORD_HASH ?? '')) {
    throw new Error('Check APP_ORIGIN, SESSION_SECRET, MANAGER_PASSWORD_HASH, and KITCHEN_PASSWORD_HASH in .env.');
}

const appUrl = new URL(appOrigin);
const secureCookie = appUrl.protocol === 'https:';
if (appUrl.origin !== appOrigin ||
    !['http:', 'https:'].includes(appUrl.protocol) ||
    (process.env.NODE_ENV === 'production' && !secureCookie)) {
    throw new Error('APP_ORIGIN must be the site origin. Production requires HTTPS.');
}

function parsePasswordHash(value) {
    const [saltHex, hashHex] = value.split(':');
    return { salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
}

const deriveKey = promisify(scrypt);
// Each staff area gets its own password, sign-in page, and session length.
const staffRoles = {
    manager: {
        password: parsePasswordHash(process.env.MANAGER_PASSWORD_HASH),
        sessionMs: 15 * 60 * 1000,
        view: 'manager',
        allowedRoles: ['manager']
    },
    kitchen: {
        password: parsePasswordHash(process.env.KITCHEN_PASSWORD_HASH),
        sessionMs: 12 * 60 * 60 * 1000, // a kitchen screen stays signed in for a shift
        view: 'kitchen',
        allowedRoles: ['kitchen', 'manager'] // managers can open the kitchen, not the reverse
    }
};
const staffPaths = Object.keys(staffRoles).map(role => `/${role}`);
const cookieName = 'pos.manager.sid';
const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie
};

app.use(staffPaths, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.get('Origin') !== appOrigin) {
        return res.sendStatus(403);
    }
    next();
});

app.use(staffPaths, session({
    name: cookieName,
    secret: sessionSecret,
    store: new PgStore({
        pool,
        createTableIfMissing: process.env.NODE_ENV !== 'production'
    }),
    resave: false,
    saveUninitialized: false,
    cookie: { ...cookieOptions, maxAge: staffRoles.manager.sessionMs }
}));

for (const [role, { password: expected, sessionMs, view, allowedRoles }] of Object.entries(staffRoles)) {
    const home = `/${role}`;
    const untilKey = `${role}Until`;
    const hasAccess = req => allowedRoles.some(r => req.session?.[`${r}Until`] > Date.now());
    const renderLogin = (res, status = 200, loginError = null) =>
        res.status(status).render(view, { [`${role}Unlocked`]: false, loginError });

    app.get(`${home}/login`, (req, res) => {
        if (hasAccess(req)) return res.redirect(303, home);
        return renderLogin(res);
    });

    // Separate limiter per role so kitchen typos never lock out the manager
    const limitLogin = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        message: 'Too many sign-in attempts. Try again in 15 minutes.'
    });

    app.post(`${home}/login`, limitLogin, async (req, res, next) => {
        const password = req.body?.password;
        if (typeof password !== 'string' ||
            password.length === 0 ||
            Buffer.byteLength(password, 'utf8') > 1024) {
            return renderLogin(res, 400, 'Enter a valid password.');
        }

        const hash = await deriveKey(password, expected.salt, expected.hash.length, {
            N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024
        });

        if (!timingSafeEqual(hash, expected.hash)) {
            return renderLogin(res, 401, 'Incorrect password.');
        }

        req.session.regenerate((err) => {
            if (err) return next(err);
            req.session[untilKey] = Date.now() + sessionMs;
            req.session.cookie.maxAge = sessionMs;
            req.session.save((saveErr) => {
                if (saveErr) return next(saveErr);
                return res.redirect(303, home);
            });
        });
    });

    app.post(`${home}/logout`, (req, res, next) => {
        req.session.destroy((err) => {
            if (err) return next(err);
            res.clearCookie(cookieName, cookieOptions);
            return res.redirect(303, `${home}/login`);
        });
    });

    app.use(home, (req, res, next) => {
        if (hasAccess(req)) return next();
        if (req.method === 'GET' || req.method === 'HEAD') {
            return res.redirect(303, `${home}/login`);
        }
        return res.status(401).send('Sign-in required.');
    });
}

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


// Place an order and automatically deduct inventory
async function handleOrder(req, res, customerAccountId = null) {

    const lines = req.body?.items;

    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({
            error: 'Order has no items.'
        });
    }

    // Optional (cashier checkout only): { method: 'card' } or { method: 'cash', tenderedCents }
    const payment = req.body?.payment;
    const paymentMethod = payment?.method ?? null;
    const tenderedCents = paymentMethod === 'cash' ? payment.tenderedCents : null;

    if (
        (payment !== undefined && paymentMethod !== 'cash' && paymentMethod !== 'card') ||
        (paymentMethod === 'cash' && (!Number.isInteger(tenderedCents) || tenderedCents < 0 || tenderedCents > 1000000))
    ) {
        return res.status(400).json({
            error: 'Invalid payment.'
        });
    }

    // -----------------------------------------
    // 1. Validate incoming order information
    // -----------------------------------------

    const parsed = [];

    for (const line of lines) {

        const menuItemId = Number(line?.id);
        const quantity = Number(line?.quantity);
        const addons = Array.isArray(line?.addons) ? line.addons : [];

        if (
            !Number.isInteger(menuItemId) ||
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 99 ||
            !addons.every(id => Object.hasOwn(ADD_ON_PRICES, id))
        ) {
            return res.status(400).json({
                error: 'Order contains an invalid item.'
            });
        }

        const addonCents = [...new Set(addons)].reduce(
            (sum, id) => sum + ADD_ON_PRICES[id],
            0
        );

        const validSugarLevels = [
            '0%', '25%', '50%', '75%', '100%'
        ];

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

    // -----------------------------------------
    // 2. Combine quantities for duplicate items
    // -----------------------------------------

    // Example:
    // Taro Milk Tea x2
    // Taro Milk Tea x3
    // 
    // Inventory deduction = 5

    const requestedByItem = new Map();

    for (const line of parsed) {

        requestedByItem.set(
            line.menuItemId,
            (requestedByItem.get(line.menuItemId) || 0) + line.quantity
        );
    }

    // -----------------------------------------
    // 3. Begin database transaction
    // -----------------------------------------

    const client = await pool.connect();

    try {

        await client.query('BEGIN');

        // Preserve your existing order ID generation strategy.
        await client.query(
            'LOCK TABLE orders, orderdetail IN EXCLUSIVE MODE'
        );

        // -----------------------------------------
        // 4. Retrieve item prices and availability
        // -----------------------------------------

        const ids = [...requestedByItem.keys()];

        const priceRes = await client.query(
            `SELECT
                menu_item_id,
                name,
                current_price,
                quantity_in_stock
             FROM menuitem
             WHERE menu_item_id = ANY($1)
               AND is_available = 1
             FOR UPDATE`,
            [ids]
        );

        const itemMap = new Map(
            priceRes.rows.map(item => [item.menu_item_id, item])
        );

        // Ensure every requested item exists and is available.
        if (itemMap.size !== ids.length) {

            await client.query('ROLLBACK');

            return res.status(400).json({
                error: 'An item in your order is no longer available.'
            });
        }

        // -----------------------------------------
        // 5. Check and deduct inventory
        // -----------------------------------------

        for (const [menuItemId, requestedQuantity] of requestedByItem) {

            const item = itemMap.get(menuItemId);

            const currentStock = Number(item.quantity_in_stock);

            // Check whether sufficient inventory exists.
            if (currentStock < requestedQuantity) {

                await client.query('ROLLBACK');

                return res.status(409).json({
                    error: `Insufficient inventory for ${item.name}. Only ${currentStock} remaining.`
                });
            }

            // Deduct inventory from the database.
            await client.query(
                `UPDATE menuitem
                 SET quantity_in_stock = quantity_in_stock - $1
                 WHERE menu_item_id = $2`,
                [requestedQuantity, menuItemId]
            );
        }

        // -----------------------------------------
        // 6. Calculate order prices
        // -----------------------------------------

        const baseCents = new Map(
            priceRes.rows.map(item => [
                item.menu_item_id,
                Math.round(Number(item.current_price) * 100)
            ])
        );

        const details = parsed.map(line => ({
            ...line,
            unitCents: baseCents.get(line.menuItemId) + line.addonCents
        }));

        const totalCents = details.reduce(
            (sum, line) => sum + line.unitCents * line.quantity,
            0
        );

        if (paymentMethod === 'cash' && tenderedCents < totalCents) {

            await client.query('ROLLBACK');

            return res.status(400).json({
                error: `Cash tendered is less than the $${(totalCents / 100).toFixed(2)} total.`
            });
        }

        // -----------------------------------------
        // 7. Insert order into database
        // -----------------------------------------

        const cashTendered = tenderedCents === null ? null : tenderedCents / 100;

        const orderRes = customerAccountId === null
            ? await client.query(
                `INSERT INTO orders (
                    order_id,
                    customer_id,
                    employee_id,
                    total_cost,
                    payment_method,
                    cash_tendered
                )
                SELECT
                    COALESCE(MAX(order_id), 0) + 1,
                    $1, $2, $3, $4, $5
                FROM orders
                RETURNING order_id`,
                [GUEST_CUSTOMER_ID, DEFAULT_EMPLOYEE_ID, totalCents / 100, paymentMethod, cashTendered]
            )
            : await client.query(
                `INSERT INTO orders (
                    order_id,
                    customer_id,
                    customer_account_id,
                    employee_id,
                    total_cost,
                    payment_method,
                    cash_tendered
                )
                SELECT
                    COALESCE(MAX(order_id), 0) + 1,
                    $1, $2, $3, $4, $5, $6
                FROM orders
                RETURNING order_id`,
                [
                    GUEST_CUSTOMER_ID,
                    customerAccountId,
                    DEFAULT_EMPLOYEE_ID,
                    totalCents / 100,
                    paymentMethod,
                    cashTendered
                ]
            );

        const orderId = orderRes.rows[0].order_id;

        // -----------------------------------------
        // 8. Insert individual order details
        // -----------------------------------------

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

        // -----------------------------------------
        // 9. Commit transaction
        // -----------------------------------------

        await client.query('COMMIT');

        return res.status(201).json({
            orderId,
            totalCents,
            changeCents: tenderedCents === null ? null : tenderedCents - totalCents
        });

    } catch (err) {

        // Any failure reverses both the order and inventory changes.
        await client.query('ROLLBACK').catch(() => {});

        console.error('Error placing order:', err);

        return res.status(500).json({
            error: 'Could not place your order. Please try again.'
        });

    } finally {

        client.release();

    }
}

app.post('/api/orders', (req, res) => handleOrder(req, res));

registerCustomerApi(app, {
    pool,
    appOrigin,
    sessionSecret,
    secureCookie,
    placeOrder: handleOrder
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

// Kitchen display: open orders oldest first, polled by public/js/kitchen.js
app.get('/kitchen', (req, res) => {
    res.render('kitchen', { kitchenUnlocked: true });
});

app.get('/kitchen/orders', async (req, res) => {
    const [open, recent] = await Promise.all([
        pool.query(
            `SELECT o.order_id,
                    EXTRACT(EPOCH FROM LOCALTIMESTAMP - o.order_timestamp)::int AS age_seconds,
                    o.started_at IS NOT NULL AS started,
                    json_agg(json_build_object(
                        'id', d.order_detail_id,
                        'name', m.name,
                        'quantity', d.quantity,
                        'sugar', d.sugar_level,
                        'ice', d.ice_level,
                        'addons', d.addons,
                        'done', d.completed_at IS NOT NULL
                    ) ORDER BY d.order_detail_id) AS items
             FROM orders o
             JOIN orderdetail d ON d.order_id = o.order_id
             JOIN menuitem m ON m.menu_item_id = d.menu_item_id
             WHERE o.completed_at IS NULL
             GROUP BY o.order_id, o.order_timestamp, o.started_at
             ORDER BY o.order_id
             LIMIT 100;`
        ),
        pool.query(
            `SELECT o.order_id,
                    EXTRACT(EPOCH FROM LOCALTIMESTAMP - o.completed_at)::int AS done_seconds_ago,
                    string_agg(d.quantity || '× ' || m.name, ', ' ORDER BY d.order_detail_id) AS summary
             FROM orders o
             JOIN orderdetail d ON d.order_id = o.order_id
             JOIN menuitem m ON m.menu_item_id = d.menu_item_id
             WHERE o.completed_at > LOCALTIMESTAMP - INTERVAL '1 hour'
             GROUP BY o.order_id, o.completed_at
             ORDER BY o.completed_at DESC
             LIMIT 10;`
        )
    ]);
    res.json({ open: open.rows, recent: recent.rows });
});

// Each kitchen action updates one row by id: 204 when it changed, 404 when it no longer applies
function kitchenAction(path, sql) {
    app.post(path, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
            return res.status(400).json({ error: 'Invalid id.' });
        }
        const result = await pool.query(sql, [id]);
        res.sendStatus(result.rowCount ? 204 : 404);
    });
}

kitchenAction('/kitchen/orders/:id/start',
    'UPDATE orders SET started_at = LOCALTIMESTAMP WHERE order_id = $1 AND completed_at IS NULL AND started_at IS NULL;');

kitchenAction('/kitchen/orders/:id/complete',
    'UPDATE orders SET completed_at = LOCALTIMESTAMP WHERE order_id = $1 AND completed_at IS NULL;');

// Recall a finished order; limited to the last hour so history can't be reopened
kitchenAction('/kitchen/orders/:id/reopen',
    `UPDATE orders SET completed_at = NULL
     WHERE order_id = $1 AND completed_at > LOCALTIMESTAMP - INTERVAL '1 hour';`);

// Check a single drink off (or back on) while its order is still open
kitchenAction('/kitchen/items/:id/toggle',
    `UPDATE orderdetail d
     SET completed_at = CASE WHEN d.completed_at IS NULL THEN LOCALTIMESTAMP END
     FROM orders o
     WHERE d.order_detail_id = $1 AND o.order_id = d.order_id AND o.completed_at IS NULL;`);

// Cashier Behind-the-Counter Interface
app.get('/cashier', async (req, res) => {
    try {
        const query_res = await pool.query('SELECT * FROM menuitem WHERE is_available = 1 ORDER BY category, menu_item_id;');
        const items = query_res.rows;
        const categories = [...new Set(items.map(item => item.category).filter(Boolean))];
        
        // Query total orders for today. 
        const count_res = await pool.query(
            "SELECT COUNT(*) as count FROM orders WHERE DATE(order_timestamp) = CURRENT_DATE;"
        );
        const todayCount = parseInt(count_res.rows[0]?.count) || 0;

        res.render('cashier', {
            vendor: process.env.VENDOR_NAME || '80s Bubble Tea',
            items: items,
            categories: categories,
            todayCount: todayCount
        });
    } catch (err) {
        console.error('Error loading cashier interface:', err);
        res.status(500).send('Server error loading cashier interface.');
    }
});

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
});
