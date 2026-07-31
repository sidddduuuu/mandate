"use client";

import { usePathname } from "next/navigation";

const links = [
  ["/dashboard", "Overview"],
  ["/dashboard/orders", "Orders"],
  ["/dashboard/suppliers", "Suppliers"],
  ["/dashboard/wallet", "Wallet"],
  ["/dashboard/audit", "Audit"],
] as const;

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Dashboard navigation">
      <ul>
        {links.map(([href, label]) => (
          <li key={href}>
            <a
              href={href}
              aria-current={pathname === href ? "page" : undefined}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
