/**
 * What the app is doing right now, in two words, always visible.
 *
 * It sits in the top bar rather than on a tab because it answers the question
 * that decides whether anything else matters — a consultant looking at an empty
 * Applied list needs to know whether that is because nothing has run yet or
 * because the app is stopped.
 */
const TONE = {
    STARTING: ['idle', 'Starting'],
    STOPPED: ['idle', 'Stopped'],
    IDLE: ['idle', 'Waiting for work'],
    WORKING: ['ok', 'Working'],
    SUBMITTING: ['ok', 'Submitting'],
    NEEDS_YOU: ['warn', 'Needs you'],
    PAUSED: ['warn', 'Paused'],
    OFFLINE: ['stop', 'Cannot reach the hub'],
    NEEDS_ACTIVATION: ['stop', 'Not activated'],
};

const StatusPill = ({ snap }) => {
    const [tone, label] = TONE[snap.state] ?? ['idle', snap.state];
    const live = snap.state === 'WORKING' || snap.state === 'SUBMITTING';

    return (
        <span className={`pill ${tone}`} title={snap.detail || undefined}>
            <span className={`dot${live ? ' live' : ''}`} />
            {label}
        </span>
    );
};

export default StatusPill;
