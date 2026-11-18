-- Cashier checkout records how an order was paid. NULL = kiosk/online order (paid outside the cashier flow).
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_method TEXT,
    ADD COLUMN IF NOT EXISTS cash_tendered NUMERIC(10, 2);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_payment_valid' AND conrelid = 'orders'::regclass
    ) THEN
        ALTER TABLE orders ADD CONSTRAINT orders_payment_valid CHECK (
            payment_method IS NULL
            OR (payment_method = 'card' AND cash_tendered IS NULL)
            OR (payment_method = 'cash' AND cash_tendered >= total_cost)
        );
    END IF;
END $$;
