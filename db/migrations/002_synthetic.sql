--Support for the synthetic supply chain.


-- The true answer for each generated pack. Only synthetic data has one: it
-- lets us measure how well a check catches each kind of fraud. Real packs
-- never get a row here.
CREATE TABLE synthetic_labels (
    serial_hash  TEXT PRIMARY KEY REFERENCES units(serial_hash) ON DELETE CASCADE,
    label        TEXT NOT NULL
                 CHECK (label IN ('genuine', 'cloned', 'diverted', 'expired_repack'))
);


-- Distance in kilometres between two points on Earth (the haversine formula).
-- Lets queries say km(a, b) instead of repeating the trigonometry. Gives the
-- same answer as distanceKm() in src/synthetic/world.js.
CREATE FUNCTION km(lat1 DOUBLE PRECISION, lon1 DOUBLE PRECISION,
                   lat2 DOUBLE PRECISION, lon2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE
AS $$
    SELECT 2 * 6371 * asin(sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2) +
        cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)
    ))
$$;
