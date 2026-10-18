import { countryPacks } from "@ssos/country-packs";
import { UI_PACKAGE } from "@ssos/ui";

// Placeholder page so the app builds. Sign-in, tenant resolution and the
// roster dashboard arrive in Slice 2.
export default function Home() {
  const packs = Object.values(countryPacks).map((p) => p.name);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Student Success OS</h1>
      <p>Foundation is in place. The app arrives in Slice 2.</p>
      <p>
        Country packs loaded: {packs.join(", ")} · UI package: {UI_PACKAGE}
      </p>
    </main>
  );
}
