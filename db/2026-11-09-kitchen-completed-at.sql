-- Kitchen display columns. Already applied to squad_80_db on 2026-11-09; only needed for a fresh database.
-- Safe to rerun.
BEGIN;
-- An order with completed_at NULL is still in the kitchen queue.
-- Existing orders are history, so mark them done, but only when the column is first added; a rerun must not clear live orders.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'orders' AND column_name = 'completed_at') THEN
        ALTER TABLE orders ADD COLUMN completed_at timestamp;
        UPDATE orders SET completed_at = order_timestamp;
    END IF;
END $$;
-- Order being made, and single drinks checked off.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS started_at timestamp;
ALTER TABLE orderdetail ADD COLUMN IF NOT EXISTS completed_at timestamp;
-- The board reads open orders, and the recall panel reads recently completed ones, every few seconds.
CREATE INDEX IF NOT EXISTS orders_pending_idx ON orders (order_id) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_completed_at_idx ON orders (completed_at);
COMMIT;
