import Image from "next/image";
import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import { auth0 } from "./auth0-page";

export default async function HomePage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";
  const loginHref = `/auth/login?organization=${encodeURIComponent(orgHint)}`;
  const primaryHref = session?.user ? "/approvals" : loginHref;

  return (
    <main id="main">
      <section className="hero" aria-label="Mandate product">
        <div
          className="hero-media"
          aria-hidden
          style={{ backgroundImage: "url(/images/hero.jpg)" }}
        />
        <div className="hero-grain" aria-hidden />
        <div className="hero-inner">
          <div className="hero-copy">
            <p className="hero-brand anim-rise">Mandate</p>
            <h1 className="hero-title anim-rise anim-rise-delay-1">
              Commerce on your terms.
            </h1>
            <p className="hero-lede anim-rise anim-rise-delay-2">
              Give every buying agent a verifiable purchasing mandate—scoped
              budgets, approved suppliers, and human approval when spend
              exceeds the line.
            </p>
            <div className="hero-cta anim-rise anim-rise-delay-3">
              <a className="btn btn-primary" href={primaryHref}>
                Get started <span className="arrow" aria-hidden>→</span>
              </a>
              <Link className="btn btn-ghost" href="/#how">
                See how it works
              </Link>
            </div>
          </div>

          <aside className="hero-panel anim-float anim-rise anim-rise-delay-2" aria-label="Featured order">
            <div className="hero-panel-image">
              <Image
                src="/images/produce.jpg"
                alt="Fresh produce ready for procurement"
                width={640}
                height={480}
              />
            </div>
            <p className="hero-panel-kicker">Awaiting approval</p>
            <h2 className="hero-panel-title">Avocado restock</h2>
            <div className="hero-panel-meta">
              <span>2 cases · produce</span>
              <span>$78.00</span>
            </div>
            <div className="hero-panel-meta" style={{ marginBottom: 0 }}>
              <span className="stars" aria-label="Policy score">★★★★☆</span>
              <span>Above autonomous limit</span>
            </div>
          </aside>
        </div>
      </section>

      <section className="section" aria-labelledby="feel-heading">
        <Reveal>
          <div className="feel-better">
            <h2 id="feel-heading">spend better</h2>
            <p>Agent commerce works better when policy, payment, and approval stay in rhythm.</p>
          </div>
        </Reveal>
      </section>

      <section className="section section-tight" id="how" aria-label="How Mandate works">
        <Reveal>
          <div className="bento">
            <article className="panel panel-dark bento-feature">
              <p className="hero-panel-kicker" style={{ color: "rgba(255,253,250,0.55)" }}>
                Purchasing mandates
              </p>
              <h3>Daily controls, not blank checks</h3>
              <p>
                Set autonomous limits, hard exceptions, suppliers, categories, and
                delivery locations. One active mandate version per organization.
              </p>
              <Link className="btn btn-ghost btn-sm" href="/mandates" style={{ alignSelf: "flex-start", marginTop: "0.5rem" }}>
                Configure mandate <span className="arrow" aria-hidden>→</span>
              </Link>
            </article>

            <div className="panel panel-media">
              <Image
                src="/images/kitchen.jpg"
                alt="Restaurant kitchen preparing for service"
                width={1200}
                height={800}
              />
            </div>

            <article className="panel panel-dark">
              <p className="hero-panel-kicker" style={{ color: "rgba(255,253,250,0.55)" }}>
                Stripe test mode
              </p>
              <h3>Pay only after policy</h3>
              <p>One PaymentIntent per accepted order. Webhooks settle truth—not redirects.</p>
            </article>

            <div className="panel panel-quote bento-quote">
              <blockquote>inside policy. outside risk.</blockquote>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="section" aria-labelledby="rail-heading">
        <Reveal>
          <div className="product-rail-head">
            <h2 id="rail-heading">Ready for more control</h2>
            <Link className="btn btn-ghost-dark btn-sm" href={primaryHref}>
              Open workspace <span className="arrow" aria-hidden>→</span>
            </Link>
          </div>
          <div className="product-rail">
            <Link className="product-tile" href="/inventory">
              <div className="product-tile-media">
                <Image src="/images/kitchen.jpg" alt="" width={800} height={1000} />
              </div>
              <h3>Inventory scan</h3>
              <p>Agent spots what the store needs</p>
            </Link>
            <Link className="product-tile" href="/needs">
              <div className="product-tile-media">
                <Image src="/images/produce.jpg" alt="" width={800} height={1000} />
              </div>
              <h3>Purchase list</h3>
              <p>Agent builds the restock order</p>
            </Link>
            <Link className="product-tile" href="/approvals">
              <div className="product-tile-media">
                <Image src="/images/hands.jpg" alt="" width={800} height={1000} />
              </div>
              <h3>Owner approval</h3>
              <p>You sign off exception spend</p>
            </Link>
            <Link className="product-tile" href="/deliveries">
              <div className="product-tile-media">
                <Image src="/images/hero.jpg" alt="" width={800} height={1000} />
              </div>
              <h3>Delivery &amp; restock</h3>
              <p>Track inbound, update inventory</p>
            </Link>
          </div>
        </Reveal>
      </section>

      <section className="section" aria-labelledby="rhythm-heading">
        <Reveal>
          <div className="rhythm">
            <div>
              <h2 id="rhythm-heading">Stay in your best rhythm.</h2>
              <p className="muted" style={{ color: "rgba(255,253,250,0.65)", marginTop: "0.75rem" }}>
                Store owners watch inventory, approve agent purchases, and track delivery restocks.
              </p>
            </div>
            <div className="rhythm-form" role="group" aria-label="Organization login">
              {session?.user ? (
                <a className="btn btn-gold" href="/inventory">
                  Open store workspace <span className="arrow" aria-hidden>→</span>
                </a>
              ) : (
                <a className="btn btn-gold" href={loginHref}>
                  Enter as store owner <span className="arrow" aria-hidden>→</span>
                </a>
              )}
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
