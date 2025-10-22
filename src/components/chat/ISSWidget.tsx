// src/components/chat/ISSWidget.tsx
import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import { Icon } from "leaflet";
import "leaflet/dist/leaflet.css";

// Reuse the worker tool's type without importing the whole module surface
export type IssResult = import("../../../worker/tools/getISS").IssResult;

/* --------------------------- tiny type guards --------------------------- */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function getNum(o: unknown, key: string): number | undefined {
  return isRecord(o) && typeof o[key] === "number" ? (o[key] as number) : undefined;
}
function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "–";
}

/* --------------------------- map helpers --------------------------- */
function ViewUpdater({ center, zoom }: { center: LatLngExpression; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom, { animate: true });
  }, [map, center, zoom]);
  return null;
}

const issIcon = new Icon({
  iconUrl:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">
         <circle cx="12" cy="12" r="6" fill="#22d3ee" stroke="#0ea5b7" stroke-width="2"/>
       </svg>`
    ),
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

/* -------------------------------- UI -------------------------------- */
export function ISSWidget({ result }: { result: IssResult }) {
  const ok = result.ok === true;

  // Safely derive the current position (defaults keep hooks deterministic)
  const { lat, lon, altitude_km, velocity_kmh, timestamp } = useMemo(() => {
    if (ok && isRecord(result)) {
      // getISS returns flat structure: { ok, lat, lon, altitude_km, velocity_kmh, ts }
      const lat = getNum(result, "lat") ?? 0;
      const lon = getNum(result, "lon") ?? 0;
      const altitude_km = getNum(result, "altitude_km");
      const velocity_kmh = getNum(result, "velocity_kmh");
      const ts = getNum(result, "ts");
      // ts is in milliseconds, convert to seconds for display
      const timestamp = typeof ts === "number" ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000);
      return { lat, lon, altitude_km, velocity_kmh, timestamp };
    }
    return {
      lat: 0,
      lon: 0,
      altitude_km: undefined as number | undefined,
      velocity_kmh: undefined as number | undefined,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }, [ok, result]);

  // Trail polyline - for now just show current position
  // (API doesn't provide historical positions)
  const trail = useMemo<LatLngExpression[]>(() => {
    return [[lat, lon]];
  }, [lat, lon]);

  const center = useMemo<LatLngExpression>(() => [lat, lon], [lat, lon]);

  const ts = useMemo(() => new Date(timestamp * 1000), [timestamp]);
  const subtitle = ok
    ? `${ts.toLocaleString()} • ${altitude_km !== undefined ? `~${fmt(altitude_km, 0)} km` : "alt –"} • ${
        velocity_kmh !== undefined ? `${fmt(velocity_kmh, 0)} km/h` : "speed –"
      }`
    : `No data`;

  const title = "International Space Station (ISS)";

  return (
    <div className="card-surface max-w-md p-4">
      <div className="mb-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</div>
      <div className="mb-3 text-xs text-neutral-600 dark:text-neutral-400">
        {ok ? subtitle : `Error: ${isRecord(result) && typeof result.error === "string" ? result.error : "Unavailable"}`}
      </div>

      {/* Map */}
      <div className="h-60 w-full overflow-hidden rounded-xl border border-neutral-200/60 dark:border-neutral-800/60">
        <MapContainer
          center={center}
          zoom={3}
          scrollWheelZoom={false}
          zoomControl={false}
          attributionControl={false}
          style={{ height: "100%", width: "100%" }}
          worldCopyJump
        >
          <ViewUpdater center={center} zoom={3} />
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {ok && (
            <>
              <Marker position={center} icon={issIcon} />
              <Polyline positions={trail} pathOptions={{ color: "#60a5fa", weight: 2, opacity: 0.85 }} />
            </>
          )}
        </MapContainer>
      </div>

      {ok && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-neutral-700 dark:text-neutral-300">
          <div className="rounded-lg border border-neutral-200/60 p-2 dark:border-neutral-800/60">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Latitude</div>
            <div className="tabular-nums">{fmt(lat, 2)}°</div>
          </div>
          <div className="rounded-lg border border-neutral-200/60 p-2 dark:border-neutral-800/60">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Longitude</div>
            <div className="tabular-nums">{fmt(lon, 2)}°</div>
          </div>
        </div>
      )}
    </div>
  );
}
