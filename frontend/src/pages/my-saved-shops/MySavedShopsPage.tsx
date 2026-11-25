import { useState } from "react";
import { Link } from "react-router";

import { useSavedShops } from "../../api/hooks";
import type { SavedShop } from "../../api/types";
import { PageMasthead } from "../../components/PageMasthead";
import { SignInPanel } from "../../components/SignInPanel";
import { TryAmount } from "../../components/TryAmount";
import { getSession, signOut, type Session } from "../../wallet";
import { providerPhotoSrc } from "../../lib/providerPhotos";
import { formatSessionFormat } from "../../lib/sessionFormat";

/**
 * `/my-saved-shops` -- a signed-in client's personal list of shops they want
 * to book again. Includes shops that are suspended or paused (not taking
 * bookings), marked accordingly.
 */
export function MySavedShopsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());

  const shopsQuery = useSavedShops(session);

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  const masthead = (
    <PageMasthead
      title="Saved shops"
      actions={
        session ? (
          <button type="button" className="button-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        ) : undefined
      }
    />
  );

  if (!session) {
    return (
      <div className="page">
        {masthead}
        <SignInPanel
          intro="Sign in to see your saved shops"
          onSignedIn={setSession}
        />
      </div>
    );
  }

  if (shopsQuery.isLoading) {
    return (
      <div className="page">
        {masthead}
        <p>Loading your saved shops…</p>
      </div>
    );
  }

  if (shopsQuery.error) {
    return (
      <div className="page">
        {masthead}
        <div className="banner banner--alert">
          <p>Connection dropped. Try again.</p>
        </div>
      </div>
    );
  }

  const shops = shopsQuery.data?.shops ?? [];

  return (
    <div className="page">
      {masthead}

      {shops.length === 0 ? (
        <div className="banner">
          <p>No saved shops yet. Browse the marketplace and save shops you want to book again.</p>
          <Link to="/discover" style={{ marginTop: "var(--space-3)", display: "inline-block" }}>
            Discover shops
          </Link>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          {shops.map((shop: SavedShop) => (
            <Link
              key={shop.id}
              to={`/providers/${shop.provider.id}`}
              className="card"
              style={{ textDecoration: "none", display: "block" }}
            >
              <div style={{ display: "flex", gap: "var(--space-4)" }}>
                <img
                  src={providerPhotoSrc(shop.provider.id)}
                  alt=""
                  style={{
                    width: "80px",
                    height: "80px",
                    borderRadius: "var(--radius-2)",
                    objectFit: "cover",
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: "var(--text-18)", marginBottom: "var(--space-1)" }}>
                    {shop.provider.displayName}
                  </h3>
                  <p style={{ fontSize: "var(--text-14)", color: "var(--color-text-secondary)", marginBottom: "var(--space-2)" }}>
                    {shop.provider.title}
                  </p>
                  <p style={{ fontSize: "var(--text-14)", color: "var(--color-text-secondary)", marginBottom: "var(--space-3)" }}>
                    {shop.provider.location}
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexWrap: "wrap" }}>
                    <div>
                      <TryAmount amount={shop.provider.priceAmount} />
                      <span style={{ fontSize: "var(--text-14)", color: "var(--color-text-secondary)", marginLeft: "var(--space-2)" }}>
                        {formatSessionFormat(shop.provider.sessionFormat)} · {shop.provider.sessionLengthMinutes} min
                      </span>
                    </div>
                    {!shop.provider.isApproved && (
                      <span
                        style={{
                          fontSize: "var(--text-12)",
                          padding: "var(--space-1) var(--space-2)",
                          backgroundColor: "var(--color-border)",
                          borderRadius: "var(--radius-1)",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        Not taking bookings
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
