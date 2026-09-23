DROP INDEX IF EXISTS external_accounts_group_iban_idx;

CREATE UNIQUE INDEX IF NOT EXISTS external_accounts_group_bank_target_idx
ON external_accounts(group_id,sepa_iban,sepa_recipient_name,coalesce(sepa_bic,''))
WHERE sepa_iban IS NOT NULL;
