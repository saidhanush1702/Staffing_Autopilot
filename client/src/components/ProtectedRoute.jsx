import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import PageLoader from './PageLoader.jsx';

/**
 * Layer 3 — frontend guard. UX ONLY, never trusted.
 *
 * This exists so users don't see links and pages they can't use. Every one of
 * these routes is independently enforced server-side; bypassing this component
 * gets you an empty screen and a 403 from the API, not data.
 */
const ProtectedRoute = ({ children, allowedRoles }) => {
    const { user, loading } = useAuth();

    // Instant decision from the cached hint, so we don't flash the login page
    // on every refresh while /auth/me is still in flight.
    const cachedRole = localStorage.getItem('userRole');

    if (loading && cachedRole) return <PageLoader />;
    if (loading) return <PageLoader />;

    if (!user) return <Navigate to="/" replace />;
    if (allowedRoles && !allowedRoles.includes(user.role)) {
        return <Navigate to="/unauthorized" replace />;
    }

    return children;
};

export default ProtectedRoute;
