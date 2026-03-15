import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { ChainProvider } from './context/ChainContext';
import AuthGuard from './components/AuthGuard';
import Navbar from './components/Navbar';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Positions = lazy(() => import('./pages/Positions'));
const PositionDetail = lazy(() => import('./pages/PositionDetail'));
const PositionAnalytics = lazy(() => import('./pages/PositionAnalytics'));
const RebalanceHistory = lazy(() => import('./pages/RebalanceHistory'));
const PositionChain = lazy(() => import('./pages/PositionChain'));
const Calculator = lazy(() => import('./pages/Calculator'));
const Info = lazy(() => import('./pages/Info'));
const Logs = lazy(() => import('./pages/Logs'));
const Integrity = lazy(() => import('./pages/Integrity'));

function RouteFallback() {
  return (
    <div className="route-stage panel min-h-[18rem] overflow-hidden p-6 sm:p-7">
      <div className="route-fallback-grid lg:grid-cols-[minmax(0,1.3fr)_minmax(20rem,0.9fr)] lg:items-end">
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="eyebrow">Loading workspace</p>
            <div className="skeleton-block h-8 w-56 max-w-full rounded-2xl" />
            <div className="skeleton-block route-fallback-bar w-full max-w-xl rounded-full" />
            <div className="skeleton-block route-fallback-bar w-3/4 rounded-full" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <div key={card} className="route-fallback-card">
                <div className="space-y-3">
                  <div className="skeleton-block h-3 w-20 rounded-full" />
                  <div className="skeleton-block h-7 w-24 rounded-2xl" />
                  <div className="skeleton-block h-3 w-16 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="route-fallback-card hidden lg:block">
          <div className="space-y-3">
            <div className="skeleton-block h-3 w-24 rounded-full" />
            <div className="skeleton-block h-6 w-40 rounded-2xl" />
            <div className="skeleton-block h-24 w-full rounded-[1.25rem]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function renderLazyPage(Page: React.ComponentType) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <div className="route-stage">
        <Page />
      </div>
    </Suspense>
  );
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <ChainProvider>
        <div className="app-shell min-h-screen">
          <Navbar />
          <main className="app-main">
            <div className="page-frame">{children}</div>
          </main>
        </div>
      </ChainProvider>
    </AuthGuard>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={renderLazyPage(Login)} />
      <Route
        path="/"
        element={
          <ProtectedLayout>
            {renderLazyPage(Dashboard)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/positions"
        element={
          <ProtectedLayout>
            {renderLazyPage(Positions)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/positions/:tokenId"
        element={
          <ProtectedLayout>
            {renderLazyPage(PositionDetail)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/positions/:tokenId/chain"
        element={
          <ProtectedLayout>
            {renderLazyPage(PositionChain)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/positions/:tokenId/analytics"
        element={
          <ProtectedLayout>
            {renderLazyPage(PositionAnalytics)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/history"
        element={
          <ProtectedLayout>
            {renderLazyPage(RebalanceHistory)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/calculator"
        element={
          <ProtectedLayout>
            {renderLazyPage(Calculator)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/logs"
        element={
          <ProtectedLayout>
            {renderLazyPage(Logs)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/info"
        element={
          <ProtectedLayout>
            {renderLazyPage(Info)}
          </ProtectedLayout>
        }
      />
      <Route
        path="/integrity"
        element={
          <ProtectedLayout>
            {renderLazyPage(Integrity)}
          </ProtectedLayout>
        }
      />
    </Routes>
  );
}
