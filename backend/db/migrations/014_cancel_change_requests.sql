-- 014_cancel_change_requests.sql
-- Purpose: let a pending profile change request be CANCELLED when the
--          consultant who submitted it is terminated.
-- Phase: 2 (remediation — finding C-2)
--
-- WHY
--   A terminated consultant could leave a request sitting in a reviewer's
--   queue forever. Approving it would push values live for someone who is no
--   longer an employee and can never sign in again; rejecting it sends a note
--   to an account that cannot read it. Neither outcome is meaningful, so the
--   request should not be there at all.
--
-- WHY A NEW STATUS RATHER THAN REUSING ONE
--   WITHDRAWN already means "the consultant changed their mind" — it is the
--   consultant's own act. Recording an admin-initiated termination as
--   WITHDRAWN would put words in the consultant's mouth and make the audit
--   trail lie about who did what. REJECTED is worse still: it implies a
--   reviewer looked at the values and turned them down.
--
--   CANCELLED is a terminal, third thing: nobody judged these values, the
--   request simply stopped being relevant.
--
-- SUSPENSION IS DELIBERATELY NOT INCLUDED HERE
--   Suspension is reversible and the person is still an employee. Discarding
--   their work for a two-week leave would mean they have to redo it on their
--   return. Those requests stay pending and the reviewer's queue flags the
--   consultant as suspended instead, so the decision is made knowingly.

ALTER TABLE profile_change_requests
    DROP CONSTRAINT IF EXISTS profile_change_requests_status_check;

ALTER TABLE profile_change_requests
    ADD CONSTRAINT profile_change_requests_status_check
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED',
                          'PARTIALLY_APPROVED', 'WITHDRAWN', 'CANCELLED'));

-- The per-field rows carry their own status. Leaving them PENDING under a
-- CANCELLED parent would misreport the queue, so they are cancelled too.
ALTER TABLE profile_change_request_fields
    DROP CONSTRAINT IF EXISTS profile_change_request_fields_status_check;

ALTER TABLE profile_change_request_fields
    ADD CONSTRAINT profile_change_request_fields_status_check
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'));

-- Any request belonging to someone already terminated before this migration
-- existed. Cancel it now so the queue starts clean.
--
-- reviewed_by is left NULL on purpose: no person made this decision, and
-- attributing it to whoever happens to run the migration would be false.
-- Cancellations from here on are attributed to the admin who terminates.
UPDATE profile_change_request_fields f
   SET status = 'CANCELLED'
  FROM profile_change_requests c
       JOIN users u ON u.id = c.consultant_id
 WHERE f.change_request_id = c.id
   AND c.status = 'PENDING'
   AND f.status = 'PENDING'
   AND u.employment_status = 'TERMINATED';

UPDATE profile_change_requests c
   SET status = 'CANCELLED',
       reviewed_at = now(),
       review_note = 'Cancelled automatically — the consultant was terminated.'
  FROM users u
 WHERE u.id = c.consultant_id
   AND c.status = 'PENDING'
   AND u.employment_status = 'TERMINATED';

COMMENT ON COLUMN profile_change_requests.status IS
    'PENDING | APPROVED | REJECTED | PARTIALLY_APPROVED | WITHDRAWN (consultant''s own act) '
    '| CANCELLED (consultant terminated — nobody judged the values)';
