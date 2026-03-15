import { useState, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/** Dispatch this event from Navbar; pages listen for it to re-fetch data. */
export const REFRESH_EVENT = 'alm-refresh';

const PRIMARY_LINKS = [
  { to: '/', label: 'Dashboard' },
  { to: '/positions', label: 'Positions' },
  { to: '/history', label: 'History' },
];

const SECONDARY_LINKS = [
  { to: '/logs', label: 'Logs' },
  { to: '/calculator', label: 'Calculator' },
  { to: '/info', label: 'Info' },
  { to: '/integrity', label: 'Integrity' },
];

function getPageTitle(pathname: string): { title: string; subtitle: string; breadcrumb: string } {
  if (pathname === '/') return { title: 'Control Deck', subtitle: 'Portfolio state, bot posture, and live exception surfaces.', breadcrumb: 'ALM / Control Deck' };
  if (pathname === '/positions') return { title: 'Position Registry', subtitle: 'Configured positions, strategies, and management controls.', breadcrumb: 'ALM / Positions' };
  if (pathname === '/history') return { title: 'Execution Log', subtitle: 'Completed rebalances, lifecycle events, and transaction chronology.', breadcrumb: 'ALM / Execution Log' };
  if (pathname === '/logs') return { title: 'Runtime Telemetry', subtitle: 'Runtime telemetry and incident inspection.', breadcrumb: 'ALM / Telemetry' };
  if (pathname === '/calculator') return { title: 'Range Calculator', subtitle: 'Off-chain planning tools for ranges, splits, and pool context.', breadcrumb: 'ALM / Calculator' };
  if (pathname === '/info') return { title: 'Operator Reference', subtitle: 'Architecture, workflow reference, and operating assumptions.', breadcrumb: 'ALM / Reference' };
  if (pathname === '/integrity') return { title: 'Data Integrity', subtitle: 'Analytics confidence, audits, and consistency checks.', breadcrumb: 'ALM / Integrity' };
  if (pathname.includes('/analytics')) return { title: 'Position Analytics', subtitle: 'Current interval versus lifetime chain profitability.', breadcrumb: 'ALM / Analytics' };
  if (pathname.includes('/chain')) return { title: 'Rebalance Chain', subtitle: 'Rebalance chain lineage, NFT handoffs, and cumulative context.', breadcrumb: 'ALM / Chain' };
  if (pathname.startsWith('/positions/')) {
    const tokenId = pathname.split('/')[2];
    return { title: 'Position Terminal', subtitle: 'Operational controls, risk state, and live LP context.', breadcrumb: `ALM / #${tokenId}` };
  }
  return { title: 'Workspace', subtitle: 'Operator tooling for concentrated liquidity management.', breadcrumb: 'ALM' };
}

export default function Navbar() {
  const { logout } = useAuth();
  const location = useLocation();
  const [spinning, setSpinning] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const pageMeta = getPageTitle(location.pathname);

  const handleRefresh = useCallback(() => {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
    setSpinning(true);
    setTimeout(() => setSpinning(false), 800);
  }, []);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `sidebar-link ${
      isActive
        ? 'sidebar-link-active'
        : 'sidebar-link-idle'
    }`;

  const renderLinks = (links: Array<{ to: string; label: string }>) => (
    <div className="space-y-1.5">
      {links.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          className={linkClass}
          end={link.to === '/'}
          onClick={() => setMobileOpen(false)}
        >
          {link.label}
        </NavLink>
      ))}
    </div>
  );

  return (
    <>
      <aside className={`app-sidebar ${mobileOpen ? 'app-sidebar-open' : ''}`}>
        <div className="app-sidebar-header">
          <div>
            <h1 className="sidebar-brand text-xl font-semibold tracking-tight text-white">ALM</h1>
            <p className="eyebrow mt-0.5 text-[10px]">Liquidity Infrastructure</p>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="app-mobile-close lg:hidden"
            aria-label="Close navigation"
          >
            ×
          </button>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-section-label">Navigate</p>
          {renderLinks(PRIMARY_LINKS)}
        </div>

        <div className="sidebar-section">
          <p className="sidebar-section-label">Tooling</p>
          {renderLinks(SECONDARY_LINKS)}
        </div>

        <div className="sidebar-footer panel-muted">
          <p className="context-label">Session</p>
          <button onClick={logout} className="action-button action-button-ghost w-full justify-center">
            Logout
          </button>
        </div>
      </aside>

      {mobileOpen && <div className="app-sidebar-backdrop" onClick={() => setMobileOpen(false)} />}

      <header className="app-topbar">
        <div className="topbar-copy">
          <button
            onClick={() => setMobileOpen(true)}
            className="action-button action-button-ghost lg:hidden"
            aria-label="Open navigation"
          >
            Menu
          </button>
          <div>
            <p className="eyebrow">{pageMeta.breadcrumb}</p>
            <h2 className="topbar-title">{pageMeta.title}</h2>
            <p className="topbar-subtitle">{pageMeta.subtitle}</p>
          </div>
        </div>

        <div className="topbar-actions">
          <button
            onClick={handleRefresh}
            title="Refresh data"
            aria-label="Refresh data"
            className="action-button action-button-secondary"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </header>
    </>
  );
}
