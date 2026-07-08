-- Track QuickBooks' own human-readable invoice number (DocNumber) alongside
-- the internal QB invoice Id we already store in qb_invoice_id — the two are
-- different values and only DocNumber is what appears in the QBO UI.
ALTER TABLE orders ADD COLUMN qb_doc_number TEXT;
