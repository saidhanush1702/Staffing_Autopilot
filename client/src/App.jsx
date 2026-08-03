import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import PageLoader from './components/PageLoader.jsx';
import Layout from './components/layout/Layout.jsx';
import Login from './pages/Login.jsx';
import Unauthorized from './pages/Unauthorized.jsx';

const PlatformDashboard = lazy(() => import('./pages/superadmin/PlatformDashboard.jsx'));
const Organizations = lazy(() => import('./pages/superadmin/Organizations.jsx'));
const OrganizationDetail = lazy(() => import('./pages/superadmin/OrganizationDetail.jsx'));

const ManagementDashboard = lazy(() => import('./pages/management/ManagementDashboard.jsx'));
const Users = lazy(() => import('./pages/management/Users.jsx'));
const Assignments = lazy(() => import('./pages/management/Assignments.jsx'));
const Consultants = lazy(() => import('./pages/management/Consultants.jsx'));
const ConsultantDetail = lazy(() => import('./pages/management/ConsultantDetail.jsx'));
const ProfileApprovals = lazy(() => import('./pages/management/ProfileApprovals.jsx'));

const ConsultantDashboard = lazy(() => import('./pages/portal/ConsultantDashboard.jsx'));
const MyProfile = lazy(() => import('./pages/portal/MyProfile.jsx'));

/** Wrap a lazy page in its guard + layout + suspense boundary. */
const route = (C, roles) => (
    <ProtectedRoute allowedRoles={roles}>
        <Layout>
            <Suspense fallback={<PageLoader />}>
                <C />
            </Suspense>
        </Layout>
    </ProtectedRoute>
);

const SUPER = ['SUPER_ADMIN'];
const ADMIN = ['ORG_ADMIN'];
const MGMT = ['ORG_ADMIN', 'RECRUITER'];
const RECRUITER = ['RECRUITER'];
const CONSULTANT = ['CONSULTANT'];

const App = () => (
    <BrowserRouter>
        <AuthProvider>
            <Routes>
                <Route path="/" element={<Login />} />
                <Route path="/unauthorized" element={<Unauthorized />} />

                {/* SUPER_ADMIN — platform */}
                <Route path="/super-admin" element={route(PlatformDashboard, SUPER)} />
                <Route path="/super-admin/organizations" element={route(Organizations, SUPER)} />
                <Route path="/super-admin/organizations/:id" element={route(OrganizationDetail, SUPER)} />

                {/* ORG_ADMIN + RECRUITER — management */}
                <Route path="/management" element={route(ManagementDashboard, MGMT)} />
                <Route path="/management/users" element={route(Users, ADMIN)} />
                <Route path="/management/assignments" element={route(Assignments, ADMIN)} />
                {/* Same screens for both roles — the server narrows a recruiter
                    to their assigned consultants. */}
                <Route path="/management/consultants" element={route(Consultants, MGMT)} />
                <Route path="/management/consultants/:id" element={route(ConsultantDetail, MGMT)} />
                <Route path="/management/approvals" element={route(ProfileApprovals, MGMT)} />

                {/* CONSULTANT — self-service portal */}
                <Route path="/portal" element={route(ConsultantDashboard, CONSULTANT)} />
                <Route path="/portal/profile" element={route(MyProfile, CONSULTANT)} />

                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </AuthProvider>
    </BrowserRouter>
);

export default App;
