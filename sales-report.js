function validDate(value) {
    if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        value < '1900-01-01' ||
        value > '9998-12-31'
    ) {
        return false;
    }

    const date = new Date(value + 'T00:00:00Z');

    return (
        Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
}

function registerSalesReport(app, pool) {
    app.get('/manager/sales', async (req, res) => {
        res.set('Cache-Control', 'no-store');

        let start = req.query.start;
        let end = req.query.end;

        const hasDateFilter =
            start !== undefined || end !== undefined;

        if (
            hasDateFilter &&
            (
                !validDate(start) ||
                !validDate(end) ||
                start > end ||
                (Date.parse(end) - Date.parse(start)) / 86400000 > 365
            )
        ) {
            return res.status(400).send(
                'Choose valid start and end dates, in order, covering at most 366 days.'
            );
        }

        let client;

        try {
            client = await pool.connect();

            // Keep every part of the report on the same database snapshot.
            await client.query(
                'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
            );

            // Default to the last seven calendar days.
            if (start === undefined) {
                const defaults = await client.query(`
                    SELECT
                        to_char(
                            CURRENT_DATE - 6,
                            'YYYY-MM-DD'
                        ) AS start,
                        to_char(
                            CURRENT_DATE,
                            'YYYY-MM-DD'
                        ) AS end
                `);

                ({ start, end } = defaults.rows[0]);
            }

            const params = [start, end];

            // Aggregate orders separately so multiple drink lines
            // do not cause an order's total to be counted repeatedly.
            const summaryResult = await client.query(`
                SELECT
                    COUNT(*)::integer AS order_count,
                    COALESCE(SUM(total_cost), 0) AS revenue,
                    COALESCE(AVG(total_cost), 0) AS average_order
                FROM orders
                WHERE order_timestamp >= $1::date
                  AND order_timestamp < $2::date + INTERVAL '1 day'
            `, params);

            // Include days with no orders.
            const dailyResult = await client.query(`
                SELECT
                    to_char(days.day, 'YYYY-MM-DD') AS day,
                    COUNT(o.order_id)::integer AS order_count,
                    COALESCE(SUM(o.total_cost), 0) AS revenue
                FROM generate_series(
                    $1::date::timestamp,
                    $2::date::timestamp,
                    INTERVAL '1 day'
                ) AS days(day)
                LEFT JOIN orders AS o
                    ON o.order_timestamp >= days.day
                   AND o.order_timestamp < days.day + INTERVAL '1 day'
                GROUP BY days.day
                ORDER BY days.day
            `, params);

            const productsResult = await client.query(`
                SELECT
                    m.name,
                    SUM(d.quantity)::bigint AS units,
                    SUM(d.quantity * d.unit_price) AS revenue
                FROM orders AS o
                JOIN orderdetail AS d
                    ON d.order_id = o.order_id
                JOIN menuitem AS m
                    ON m.menu_item_id = d.menu_item_id
                WHERE o.order_timestamp >= $1::date
                  AND o.order_timestamp < $2::date + INTERVAL '1 day'
                GROUP BY m.menu_item_id, m.name
                ORDER BY units DESC, revenue DESC, m.menu_item_id
            `, params);

            await client.query('COMMIT');

            const products = productsResult.rows;
            const daily = dailyResult.rows;

            res.render('sales', {
                start,
                end,
                summary: summaryResult.rows[0],
                daily,
                products,
                units: products.reduce(
                    (sum, product) => sum + Number(product.units),
                    0
                ),
                maxRevenue: Math.max(
                    1,
                    ...daily.map(day => Number(day.revenue))
                )
            });
        } catch (error) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
            }

            console.error('Sales report failed:', error.message);

            res.status(503).send(
                'Sales reports are temporarily unavailable. Please try again.'
            );
        } finally {
            if (client) {
                client.release();
            }
        }
    });
}

module.exports = { registerSalesReport, validDate };