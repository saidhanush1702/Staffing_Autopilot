/**
 * 059 — five more career systems for the ATS live mirror
 *
 * Additive and idempotent, like 058: new rows in `lkp_ats_families`, and the one
 * portal type the seed does not already carry. Adding a family is one adapter
 * file, one row here and a branch in connectors/ats/detect.js — nothing
 * downstream changes.
 *
 *   RECRUITEE   {slug}.recruitee.com/api/offers/            no ETag, full detail in the list
 *   WORKABLE    apply.workable.com/api/v3/accounts/{slug}   no ETag, detail request per NEW job
 *   BREEZY      {slug}.breezy.hr/json                       ETag, description from the job page
 *   PERSONIO    {slug}.jobs.personio.de/xml                 ETag, full detail in the list
 *   BAMBOOHR    {slug}.bamboohr.com/careers/list            no ETag, detail request per NEW job
 *
 * The floors are kept deliberately conservative: none of these publishes a
 * cache policy that makes faster polling pay, and several are small vendors.
 */

INSERT INTO lkp_ats_families
    (name, label, portal_type, min_interval_s, supports_etag, list_has_detail, sort_order)
VALUES
    ('RECRUITEE', 'Recruitee',  'RECRUITEE', 120, FALSE, TRUE,  6),
    ('WORKABLE',  'Workable',   'WORKABLE',  120, FALSE, FALSE, 7),
    ('BREEZY',    'Breezy HR',  'BREEZY',    120, TRUE,  FALSE, 8),
    ('PERSONIO',  'Personio',   'PERSONIO',  120, TRUE,  TRUE,  9),
    ('BAMBOOHR',  'BambooHR',   'BAMBOOHR',  180, FALSE, FALSE, 10)
ON CONFLICT (name) DO UPDATE
    SET label = EXCLUDED.label,
        portal_type = EXCLUDED.portal_type,
        min_interval_s = EXCLUDED.min_interval_s,
        supports_etag = EXCLUDED.supports_etag,
        list_has_detail = EXCLUDED.list_has_detail,
        sort_order = EXCLUDED.sort_order;

-- Workable, BambooHR, Recruitee and Breezy are already in the portal-type seed;
-- Personio is not. Not automatable: like every other ATS here, the apply form
-- is the employer's own.
INSERT INTO lkp_portal_types (name, label, is_automatable)
VALUES ('PERSONIO', 'Personio', FALSE)
ON CONFLICT (name) DO NOTHING;
