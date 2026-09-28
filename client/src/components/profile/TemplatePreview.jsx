/**
 * A miniature of the page a template actually prints.
 *
 * ── WHY A PICTURE AND NOT A LIST OF SECTION NAMES ─────────────────────
 *
 * The three templates differ in the order things appear, where the weight
 * falls, and how the page furniture is set. "summary → education → skills" is
 * technically the same information, but nobody reads it and pictures a page —
 * so an admin choosing between them was choosing between three paragraphs
 * rather than three documents.
 *
 * ── WHY IT MIRRORS THE RENDERER RATHER THAN INVENTING A LOOK ──────────
 *
 * The section order, the emphasis and the three style knobs all come from the
 * template definition the server sends. So this is a preview, not an
 * illustration: change a template and this changes with it, and it cannot
 * drift into showing a layout the system does not produce.
 *
 *   headerAlign   where the name sits            center | left
 *   headerRule    is there a rule under it       true | false
 *   headingStyle  how a heading is set           rule | plain | band
 *
 * The body is skeleton bars rather than sample sentences on purpose. The
 * question this answers is "what shape is the page" — filling it with invented
 * prose would make an admin read the words instead of the structure, and
 * invite them to think the sample was somebody's real resume.
 */

/**
 * The headings, character for character as the PDF prints them.
 *
 * Mirrors SECTION_LABELS in backend/services/resumePdf.js. Duplicated rather
 * than fetched because it is seven strings that change roughly never, and a
 * round trip to draw a thumbnail is a round trip nobody needs — but it does
 * have to change in both places, which is why it says so here.
 */
const SECTION_LABELS = {
    summary: 'PROFESSIONAL SUMMARY',
    skills: 'TECHNICAL SKILLS',
    experience: 'PROFESSIONAL EXPERIENCE',
    projects: 'PROJECTS',
    education: 'EDUCATION',
    certifications: 'CERTIFICATIONS',
    additional: 'ADDITIONAL INFORMATION',
};

/** A skeleton line. `w` is a percentage; `dark` marks the bold-set lines. */
const Line = ({ w = 100, dark = false }) => (
    <div
        className={`h-[2px] rounded-full ${dark ? 'bg-slate-400' : 'bg-slate-200'}`}
        style={{ width: `${w}%` }}
    />
);

/** A bulleted line, drawn the way the renderer draws one. */
const Bullet = ({ w = 90 }) => (
    <div className="flex items-center gap-[3px]">
        <div className="h-[2px] w-[2px] shrink-0 rounded-full bg-slate-300" />
        <div className="h-[2px] rounded-full bg-slate-200" style={{ width: `${w}%` }} />
    </div>
);

/**
 * What each section looks like once drawn.
 *
 * Shapes follow the real renderer: an experience entry is a bold
 * "Title — Company" line, a lighter meta line, then bullets. Skills are a bold
 * category followed by a run of items on the same line.
 */
const BODY = {
    summary: () => (
        <div className="space-y-[3px]"><Line w={100} /><Line w={92} /></div>
    ),
    skills: () => (
        <div className="space-y-[3px]">
            {[62, 70].map((w, i) => (
                <div key={i} className="flex items-center gap-[3px]">
                    <div className="h-[2px] w-[18%] shrink-0 rounded-full bg-slate-400" />
                    <div className="h-[2px] rounded-full bg-slate-200" style={{ width: `${w}%` }} />
                </div>
            ))}
        </div>
    ),
    experience: () => (
        <div className="space-y-[5px]">
            {[0, 1].map((i) => (
                <div key={i} className="space-y-[3px]">
                    <Line w={58} dark /><Line w={38} />
                    <Bullet w={88} /><Bullet w={74} />
                </div>
            ))}
        </div>
    ),
    projects: () => (
        <div className="space-y-[5px]">
            {[0, 1].map((i) => (
                <div key={i} className="space-y-[3px]">
                    <Line w={44} dark /><Bullet w={82} />
                </div>
            ))}
        </div>
    ),
    education: () => (
        <div className="space-y-[3px]"><Line w={56} dark /><Line w={34} /></div>
    ),
    certifications: () => (
        <div className="space-y-[3px]"><Bullet w={68} /><Bullet w={54} /></div>
    ),
    additional: () => <div className="space-y-[3px]"><Bullet w={60} /></div>,
};

/**
 * A heading, set the way its template sets it.
 *
 * The four treatments are the most visible difference between the templates,
 * so getting them right here is most of what makes the thumbnails worth having.
 * `accent`, when the template names one (MODERN's navy), overrides the tone
 * that would otherwise come from `lead` — a template's own colour is not
 * conditional on which section is being emphasised.
 */
const Heading = ({ label, style, lead, accent }) => {
    const tone = accent ? '' : (lead ? 'text-brand-600' : 'text-slate-700');
    const toneStyle = accent ? { color: accent } : undefined;
    const type = 'text-[6px] leading-[1.35] font-semibold tracking-[0.09em]';

    // A shaded strip with the heading set inside it.
    if (style === 'band') {
        return (
            <div
                className={`rounded-[1px] px-[4px] py-[2px]
                            ${lead ? 'bg-brand-100' : 'bg-slate-100'}`}
            >
                <p className={`${type} ${tone}`} style={toneStyle}>{label}</p>
            </div>
        );
    }

    // Bold and underlined, colon-suffixed — no drawn rule.
    if (style === 'underline') {
        return <p className={`${type} ${tone} underline`} style={toneStyle}>{label}:</p>;
    }

    // Bold text with a trailing colon, no adornment at all — the plainest.
    if (style === 'label') {
        return <p className={`${type} ${tone}`} style={toneStyle}>{label}:</p>;
    }

    // The default 'rule': heading with a hairline rule under it, full width.
    // The rule takes the same accent colour as the heading when one is set.
    return (
        <>
            <p className={`${type} ${tone}`} style={toneStyle}>{label}</p>
            <div
                className={`mt-[1.5px] h-[0.5px] w-full ${accent ? '' : (lead ? 'bg-brand-300' : 'bg-slate-300')}`}
                style={accent ? { backgroundColor: accent, opacity: 0.7 } : undefined}
            />
        </>
    );
};

const TemplatePreview = ({ sections = [], emphasis = [], style = {} }) => {
    const {
        headerAlign = 'center', headerRule = true, headerRuleWidth = 1,
        headingStyle = 'rule', headingColor, nameColor, fontFamily,
    } = style;

    const centred = headerAlign === 'center';
    // Compact templates (a coloured 'rule', or the plain 'label' treatment)
    // need less room between sections to read as tight rather than sparse;
    // 'band' is roomier because the shading itself needs breathing space.
    const gap = headingStyle === 'band' ? 'space-y-[7px]'
        : (headingStyle === 'label' || (headingStyle === 'rule' && headingColor)) ? 'space-y-[5px]'
            : 'space-y-[6px]';

    const serif = fontFamily === 'times' ? 'font-serif' : '';

    return (
        <div
            className={`w-full overflow-hidden rounded-sm border border-line bg-surface
                       px-[9%] py-[6%] shadow-xs ${serif}`}
            // US Letter, the size the renderer actually sets.
            style={{ aspectRatio: '8.5 / 11' }}
            aria-hidden="true"
        >
            {/* ── the name block ────────────────────────────────────── */}
            <div className={centred ? 'text-center' : 'text-left'}>
                <div
                    className={`h-[5px] rounded-full ${nameColor ? '' : 'bg-slate-500'}
                                ${centred ? 'mx-auto' : ''}`}
                    // MODERN sets a noticeably larger name; the colour comes
                    // from the template when it names one (MODERN's navy).
                    style={{ width: headerRule === false ? '52%' : '44%', backgroundColor: nameColor }}
                />
                {/* Contact details as plain text on one line — not icons. A
                    phone glyph carries nothing into the text an applicant
                    tracking system extracts. */}
                <div
                    className={`mt-[3px] h-[2px] rounded-full bg-slate-300
                                ${centred ? 'mx-auto' : ''}`}
                    style={{ width: '62%' }}
                />
            </div>

            {headerRule !== false ? (
                <div
                    className={`mt-[4px] w-full ${headingColor ? '' : 'bg-slate-400'}`}
                    style={{ height: `${Math.max(0.5, headerRuleWidth)}px`, backgroundColor: headingColor }}
                />
            ) : (
                // No rule — the whitespace separates the header instead.
                <div className="mt-[7px]" />
            )}

            {/* ── the sections, in this template's order ────────────── */}
            <div className={`mt-[6px] ${gap}`}>
                {sections.map((key) => {
                    const label = SECTION_LABELS[key];
                    if (!label) return null;
                    const Body = BODY[key];

                    return (
                        <div key={key}>
                            <Heading
                                label={label}
                                style={headingStyle}
                                lead={emphasis.includes(key)}
                                accent={headingColor}
                            />
                            <div className="mt-[3px]">
                                {Body ? <Body /> : <Line w={80} />}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default TemplatePreview;
