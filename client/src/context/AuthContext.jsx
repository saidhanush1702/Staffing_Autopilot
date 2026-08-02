import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../api/axios.js';

const AuthContext = createContext(null);

/**
 * Session state.
 *
 * The httpOnly cookie is the source of truth — this context just mirrors it in
 * memory. localStorage.userRole exists only so ProtectedRoute can make an
 * instant redirect decision before /auth/me resolves; it is a UX hint and is
 * never trusted by the server.
 */
export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const { data } = await api.get('/auth/me');
            setUser(data);
            localStorage.setItem('userRole', data.role);
            return data;
        } catch {
            setUser(null);
            localStorage.removeItem('userRole');
            return null;
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const login = async (email, password) => {
        const { data } = await api.post('/auth/login', { email, password });
        localStorage.setItem('userRole', data.role);
        await refresh();
        return data;
    };

    const logout = async () => {
        try { await api.post('/auth/logout'); } catch { /* clear locally regardless */ }
        localStorage.removeItem('userRole');
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
};
