import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link className="brand" href="/">
        Mandate
      </Link>
      <p>
        Agentic store commerce — inventory scan, purchase list, owner approval, delivery restock.
      </p>
    </footer>
  );
}
