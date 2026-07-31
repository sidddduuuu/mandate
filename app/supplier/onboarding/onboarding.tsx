"use client";

import { loadConnectAndInitialize } from "@stripe/connect-js";
import { useEffect, useRef } from "react";

export function SupplierOnboarding({ publishableKey }: Readonly<{ publishableKey: string }>) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const connect = loadConnectAndInitialize({
      publishableKey,
      fetchClientSecret: async () => {
        const response = await fetch("/api/suppliers/connect", { method: "POST" });
        const payload = await response.json();
        if (!response.ok || typeof payload.data?.clientSecret !== "string") {
          throw new Error(payload.error?.message || "Onboarding is unavailable");
        }
        return payload.data.clientSecret;
      },
      appearance: {
        variables: {
          colorPrimary: "#171714",
          colorBackground: "#f7f5ef",
          colorText: "#171714",
          borderRadius: "0px",
        },
      },
    });
    const banner = connect.create("notification-banner");
    const onboarding = connect.create("account-onboarding");
    onboarding.setOnExit(() => window.location.reload());
    container.current.replaceChildren(banner, onboarding);
    const current = container.current;
    return () => current.replaceChildren();
  }, [publishableKey]);

  return <div ref={container} />;
}
