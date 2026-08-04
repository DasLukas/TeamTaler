ALTER TABLE invitations
ADD COLUMN category_grants_json TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(category_grants_json));
