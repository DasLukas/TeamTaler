-- Remove terminal rows left behind by the former READY-export deletion flow.
-- These rows have retained integrity metadata but no longer reference an artifact.
DELETE FROM export_jobs
WHERE status = 'CANCELLED'
  AND artifact_name IS NULL
  AND size_bytes IS NOT NULL
  AND sha256 IS NOT NULL;
