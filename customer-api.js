const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { rateLimit } = require('express-rate-limit');
const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const deriveKey = promisify(scrypt);
const CUSTOMER_SESSION_MS = 12 * 60 * 60 * 1000;
const CUSTOMER_COOKIE_NAME = 'pos.customer.sid';
const PASSWORD_HASH_BYTES = 64;
const SCRYPT_OPTIONS = {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024
};
const DUMMY_SALT = randomBytes(16);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    if (
        Buffer.byteLength(email, 'utf8') > 254 ||
        !EMAIL_PATTERN.test(email)
    ) {
        return null;
    }
    return email;
}

function validPassword(value, isRegistration = false) {
    return typeof value === 'string' &&
        (!isRegistration || value.length >= 8) &&
        Buffer.byteLength(value, 'utf8') <= 1024;
}

function regenerateSession(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate(error => error ? reject(error) : resolve());
    });
}

function saveSession(req) {
    return new Promise((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
    });
}

function accountResponse(row) {
    return {
        customerId: row.customer_account_id,
        email: row.email,
        preferences: row.preferences,
        createdAt: row.created_at
    };
}

function registerCustomerApi(app, {
    pool,
    appOrigin,
    sessionSecret,
    secureCookie,
    placeOrder
}) {
    const customerCookie = {
        path: '/api/customer',
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookie,
        maxAge: CUSTOMER_SESSION_MS
    };

    app.use('/api/customer', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (
            !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
            req.get('Origin') !== appOrigin
        ) {
            return res.sendStatus(403);
        }
        next();
    });

    app.use('/api/customer', session({
        name: CUSTOMER_COOKIE_NAME,
        secret: sessionSecret,
        store: new PgStore({
            pool,
            createTableIfMissing: process.env.NODE_ENV !== 'production'
        }),
        resave: false,
        saveUninitialized: false,
        cookie: customerCookie
    }));

    const limitCustomerAuth = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 5,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many attempts. Try again in 15 minutes.' }
    });

    function requireCustomer(req, res, next) {
        const customerId = req.session?.customerAccountId;
        if (!Number.isSafeInteger(customerId) || customerId < 1) {
            return res.status(401).json({ error: 'Customer sign-in required.' });
        }
        next();
    }

    function requireJsonBody(req, res, next) {
        if (!req.is('application/json')) {
            return res.status(415).json({ error: 'Send a JSON request body.' });
        }
        next();
    }

    app.post('/api/customer/register', limitCustomerAuth, requireJsonBody, async (req, res, next) => {
        const email = normalizeEmail(req.body?.email);
        const password = req.body?.password;
        if (!email || !validPassword(password, true)) {
            return res.status(400).json({
                error: 'Enter a valid email and a password of at least 8 characters.'
            });
        }

        try {
            const salt = randomBytes(16);
            const hash = await deriveKey(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS);
            const result = await pool.query(
                `INSERT INTO customer_accounts (email, password_salt, password_hash)
                 VALUES ($1, $2, $3)
                 RETURNING customer_account_id, email, preferences, created_at`,
                [email, salt, hash]
            );

            await regenerateSession(req);
            req.session.customerAccountId = result.rows[0].customer_account_id;
            await saveSession(req);

            return res.status(201).json({ customer: accountResponse(result.rows[0]) });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ error: 'An account with that email already exists.' });
            }
            return next(error);
        }
    });

    app.post('/api/customer/login', limitCustomerAuth, requireJsonBody, async (req, res, next) => {
        const email = normalizeEmail(req.body?.email);
        const password = req.body?.password;
        if (!email || !validPassword(password)) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        try {
            const result = await pool.query(
                `SELECT customer_account_id, email, password_salt, password_hash,
                        preferences, created_at
                 FROM customer_accounts
                 WHERE email = $1`,
                [email]
            );
            const account = result.rows[0];
            const salt = account?.password_salt || DUMMY_SALT;
            const expectedHash = account?.password_hash || Buffer.alloc(PASSWORD_HASH_BYTES);
            const actualHash = await deriveKey(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS);
            const hashMatches = Buffer.isBuffer(expectedHash) &&
                expectedHash.length === actualHash.length &&
                timingSafeEqual(actualHash, expectedHash);

            if (!account || !hashMatches) {
                return res.status(401).json({ error: 'Invalid email or password.' });
            }

            await regenerateSession(req);
            req.session.customerAccountId = account.customer_account_id;
            await saveSession(req);
            return res.json({ customer: accountResponse(account) });
        } catch (error) {
            return next(error);
        }
    });

    app.post('/api/customer/logout', (req, res, next) => {
        req.session.destroy(error => {
            if (error) return next(error);
            res.clearCookie(CUSTOMER_COOKIE_NAME, customerCookie);
            return res.status(204).end();
        });
    });

    app.get('/api/customer/me', requireCustomer, async (req, res, next) => {
        try {
            const result = await pool.query(
                `SELECT customer_account_id, email, preferences, created_at
                 FROM customer_accounts
                 WHERE customer_account_id = $1`,
                [req.session.customerAccountId]
            );
            if (result.rowCount === 0) {
                return res.status(401).json({ error: 'Customer sign-in required.' });
            }
            return res.json({ customer: accountResponse(result.rows[0]) });
        } catch (error) {
            return next(error);
        }
    });

    app.get('/api/customer/me/preferences', requireCustomer, async (req, res, next) => {
        try {
            const result = await pool.query(
                `SELECT preferences FROM customer_accounts WHERE customer_account_id = $1`,
                [req.session.customerAccountId]
            );
            if (result.rowCount === 0) {
                return res.status(401).json({ error: 'Customer sign-in required.' });
            }
            return res.json({ preferences: result.rows[0].preferences });
        } catch (error) {
            return next(error);
        }
    });

    app.put('/api/customer/me/preferences', requireJsonBody, requireCustomer, async (req, res, next) => {
        const updates = req.body;
        const allowed = new Set(['textSize', 'highContrast']);
        if (
            !updates || typeof updates !== 'object' || Array.isArray(updates) ||
            Object.keys(updates).length === 0 ||
            Object.keys(updates).some(key => !allowed.has(key)) ||
            (Object.hasOwn(updates, 'textSize') && ![100, 125, 150, 175, 200].includes(updates.textSize)) ||
            (Object.hasOwn(updates, 'highContrast') && typeof updates.highContrast !== 'boolean')
        ) {
            return res.status(400).json({ error: 'Invalid accessibility preferences.' });
        }

        try {
            const result = await pool.query(
                `UPDATE customer_accounts
                 SET preferences = preferences || $1::jsonb
                 WHERE customer_account_id = $2
                 RETURNING preferences`,
                [JSON.stringify(updates), req.session.customerAccountId]
            );
            if (result.rowCount === 0) {
                return res.status(401).json({ error: 'Customer sign-in required.' });
            }
            return res.json({ preferences: result.rows[0].preferences });
        } catch (error) {
            return next(error);
        }
    });

    app.post('/api/customer/orders', requireJsonBody, requireCustomer, (req, res) => {
        return placeOrder(req, res, req.session.customerAccountId);
    });

    app.get('/api/customer/orders', requireCustomer, async (req, res, next) => {
        try {
            const result = await pool.query(
                `SELECT o.order_id AS "orderId",
                        ROUND(o.total_cost * 100)::integer AS "totalCents",
                        to_char(o.order_timestamp, 'Mon FMDD, YYYY FMHH12:MI AM') AS "placedAt",
                        COALESCE(
                            json_agg(json_build_object(
                                'name', m.name,
                                'quantity', d.quantity,
                                'unitPrice', d.unit_price,
                                'sugar', d.sugar_level,
                                'ice', d.ice_level,
                                'addons', d.addons
                            ) ORDER BY d.order_detail_id)
                            FILTER (WHERE d.order_detail_id IS NOT NULL),
                            '[]'::json
                        ) AS items
                 FROM orders o
                 LEFT JOIN orderdetail d ON d.order_id = o.order_id
                 LEFT JOIN menuitem m ON m.menu_item_id = d.menu_item_id
                 WHERE o.customer_account_id = $1
                 GROUP BY o.order_id, o.order_timestamp, o.total_cost
                 ORDER BY o.order_id DESC
                 LIMIT 25`,
                [req.session.customerAccountId]
            );
            return res.json({ orders: result.rows });
        } catch (error) {
            return next(error);
        }
    });

    app.use('/api/customer', (error, req, res, next) => {
        if (res.headersSent) return next(error);
        console.error('Customer API error:', error);
        return res.status(500).json({ error: 'Customer request could not be completed.' });
    });
}

module.exports = { registerCustomerApi };
