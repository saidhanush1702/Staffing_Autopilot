import { MapPin, Briefcase, Banknote, Tag, Ban } from 'lucide-react';
import { badge, TONE, sectionTitle } from '../../design/tokens.js';
import { useLookups } from '../../context/LookupContext.jsx';

/** "Dallas, TX · Hybrid · 40 mi" — one readable line per location. */
export const describeLocation = (l) => [
    [l.city, l.state].filter(Boolean).join(', ') || 'Anywhere',
    l.workMode.charAt(0) + l.workMode.slice(1).toLowerCase(),
    l.radiusMiles ? `${l.radiusMiles} mi` : null,
].filter(Boolean).join(' · ');

/**
 * Minimum pay, always with its unit.
 *
 * "60" on its own is either an hourly rate or a catastrophic salary
 * expectation, so the unit is never dropped for brevity.
 */
export const describePay = (minPay) => {
    if (!minPay || minPay.amount === null || minPay.amount === undefined) return null;
    const amount = Number(minPay.amount).toLocaleString();
    return minPay.unit === 'HOURLY'
        ? `${minPay.currency} ${amount} / hour`
        : `${minPay.currency} ${amount} / year`;
};

const Group = ({ icon: Icon, title, children, empty }) => (
    <div>
        <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-400">
            <Icon className="h-3.5 w-3.5" /> {title}
        </p>
        <div className="mt-1.5">{children ?? <span className="text-sm text-slate-400">{empty}</span>}</div>
    </div>
);

const Chips = ({ values, tone = 'neutral', numbered = false }) => (
    values.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
            {values.map((v, i) => (
                <span key={`${v}-${i}`} className={`${badge} ${TONE[tone]}`}>
                    {numbered && <span className="tabular-nums opacity-60">{i + 1}.</span>}
                    {v}
                </span>
            ))}
        </div>
    )
);

/**
 * Read-only render of one criteria version.
 *
 * Used by the consultant's portal (where it is the ONLY thing they get — R-23)
 * and by the version viewer on the management side, so an old version and a
 * live one always look the same.
 */
const CriteriaView = ({ version }) => {
    const { labelById } = useLookups();

    if (!version || !version.id) {
        return (
            <p className="text-sm text-slate-400">
                No search criteria have been set up yet.
            </p>
        );
    }

    const pay = describePay(version.minPay);
    const workTypes = version.workTypeIds.map((id) => labelById('workTypes', id)).filter(Boolean);

    return (
        <div className="space-y-5">
            <Group icon={Briefcase} title="Job titles, in priority order" empty="None set">
                <Chips values={version.jobTitles} tone="brand" numbered />
            </Group>

            <div className="grid gap-5 sm:grid-cols-2">
                <Group icon={Tag} title="Include keywords" empty="None set">
                    <Chips values={version.keywordsInclude} tone="success" />
                </Group>
                <Group icon={Ban} title="Exclude keywords" empty="None set">
                    <Chips values={version.keywordsExclude} tone="danger" />
                </Group>
            </div>

            <Group icon={MapPin} title="Locations" empty="None set">
                {version.locations.length > 0 && (
                    <ul className="space-y-1">
                        {version.locations.map((l, i) => (
                            <li key={i} className="text-sm text-slate-700">{describeLocation(l)}</li>
                        ))}
                    </ul>
                )}
            </Group>

            <div className="grid gap-5 sm:grid-cols-2">
                <Group icon={Briefcase} title="Work types" empty="None set">
                    <Chips values={workTypes} tone="info" />
                </Group>
                <Group icon={Banknote} title="Minimum pay" empty="No minimum set">
                    {pay && <p className="text-sm font-medium text-slate-800">{pay}</p>}
                </Group>
            </div>

            {version.excludedCompanies.length > 0 && (
                <Group icon={Ban} title="Excluded companies">
                    <Chips values={version.excludedCompanies} tone="warning" />
                </Group>
            )}
        </div>
    );
};

/** Header line naming who saved a version and when. */
export const VersionByline = ({ version }) => {
    if (!version?.id) return null;
    return (
        <p className="text-xs text-slate-500">
            <span className={sectionTitle}>Version {version.versionNo}</span>
            {' · '}
            {version.createdByName ?? 'Unknown'}
            {version.createdByRole && (
                <span className="ml-1 text-slate-400">{version.createdByRole}</span>
            )}
            {' · '}
            {new Date(version.createdAt).toLocaleString()}
            {version.changeNote && <span className="block italic">“{version.changeNote}”</span>}
        </p>
    );
};

export default CriteriaView;
