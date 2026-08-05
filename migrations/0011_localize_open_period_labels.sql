UPDATE periods
SET label = 'Aktueller Zeitraum'
WHERE status = 'OPEN'
  AND label IN ('Current period', 'Next period');
