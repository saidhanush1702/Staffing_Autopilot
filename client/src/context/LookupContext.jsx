import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api/axios.js';
import { useAuth } from './AuthContext.jsx';

/**
 * ── REFERENCE DATA, FETCHED ONCE ──────────────────────────────────────
 *
 * `GET /api/lookups` returns every `lkp_` table in one call. This provider
 * fetches it once per session and hands it to the whole tree, so no screen
 * has to hardcode a role name, a status label, or a dropdown's options.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────
 *
 * A value the DATABASE stores (`ORG_ADMIN`, `SUSPENDED`) is a contract. It
 * belongs in code — route guards and comparisons must not depend on a
 * network fetch, and a label change must never break authorisation.
 *
 * The TEXT SHOWN TO A PERSON for that value is not a contract. It comes
 * from the lookup table, so renaming "Organization Admin" is a seed change
 * and not a hunt through JSX.
 *
 *   ✅  if (user.role === ROLES.ORG_ADMIN)      compare against the constant
 *   ✅  <RoleBadge role={u.role} />             display via the lookup
 *   ❌  <span>Organization Admin</span>         hardcoded label
 *
 *   const { roleLabel, statusLabel, options } = useLookups();
 *   roleLabel('ORG_ADMIN')        → 'Organization Admin'
 *   statusLabel('SUSPENDED')      → 'Suspended'
 *   options('workAuthStatuses')   → [{ id, name }, …]  for a <select>
 */

const LookupContext = createContext(null);

/** Turn a stored enum into something readable, if the lookup has not arrived. */
const humanise = (value) => String(value ?? '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

export const LookupProvider = ({ children }) => {
    const { user } = useAuth();
    const [lookups, setLookups] = useState(null);

    useEffect(() => {
        // Needs a session — the endpoint is behind verifyToken.
        if (!user) { setLookups(null); return; }

        let cancelled = false;
        api.get('/lookups')
            .then(({ data }) => { if (!cancelled) setLookups(data); })
            // A failed fetch must not blank the UI. `humanise` covers the gap
            // until the next load, showing "Org Admin" rather than nothing.
            .catch(() => { if (!cancelled) setLookups(null); });

        return () => { cancelled = true; };
    }, [user]);

    const value = useMemo(() => {
        /** Rows of one lookup, ready for a <select>. */
        const options = (key) => lookups?.[key] ?? [];

        /** The display text for a stored value, from `name` → `label`. */
        const labelFrom = (key, name) => {
            if (name === null || name === undefined || name === '') return '';
            const row = options(key).find((o) => o.name === name);
            return row?.label ?? row?.name ?? humanise(name);
        };

        /** The display text for a lookup row referenced by id. */
        const labelById = (key, id) => {
            if (id === null || id === undefined) return '';
            const row = options(key).find((o) => String(o.id) === String(id));
            return row?.label ?? row?.name ?? '';
        };

        return {
            lookups,
            ready: lookups !== null,
            options,
            labelFrom,
            labelById,
            roleLabel: (name) => labelFrom('roles', name),
            statusLabel: (name) => labelFrom('userStatuses', name),
            workAuthLabel: (id) => labelById('workAuthStatuses', id),
        };
    }, [lookups]);

    return <LookupContext.Provider value={value}>{children}</LookupContext.Provider>;
};

export const useLookups = () => {
    const ctx = useContext(LookupContext);
    if (!ctx) throw new Error('useLookups must be used inside <LookupProvider>.');
    return ctx;
};
