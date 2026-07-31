import type { ReactNode } from "react";

import { loadDashboardSnapshot } from "../../src/dashboard";
import { DashboardNav } from "./dashboard-nav";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const snapshot = await loadDashboardSnapshot();

  return (
    <div className="dashboard-app">
      <a className="skip-link" href="#dashboard-content">Skip to content</a>
      <aside className="dashboard-sidebar">
        <a className="screen-brand" href="/">MANDATE</a>
        <div>
          <p className="screen-label">Organization</p>
          <p className="dashboard-org">{snapshot.organizationName}</p>
        </div>
        <DashboardNav />
        <div className="screen-foot">
          <p>Test mode · M-104</p>
          <p>● Auth0 verified</p>
          <p>{snapshot.displayName}</p>
          <a href="/auth/logout">Sign out</a>
        </div>
      </aside>
      <div className="dashboard-page" id="dashboard-content">
        {children}
      </div>
    </div>
  );
}
