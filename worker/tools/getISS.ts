// worker/tools/getISS.ts

/** Input accepted by the ISS tool (kept minimal for now) */
export type IssArgs = Record<string, never>; // no args yet

/** Live position from where the ISS is right now */
export type IssOk = {
  ok: true;
  lat: number;
  lon: number;
  /** km above sea level */
  altitude_km?: number;
  /** km/h */
  velocity_kmh?: number;
  /** "daylight" | "eclipsed" when available */
  visibility?: string;
  /** Unix ms timestamp when fetched */
  ts: number;
};

/** Error shape */
export type IssErr = { ok: false; error: string };

export type IssResult = IssOk | IssErr;

/** Tool schema (Workers AI “function tool” shape) */
export const getISSToolSchema = {
  type: "function",
  function: {
    name: "getISS",
    description:
      "Fetch the International Space Station's current position (latitude/longitude) and basic telemetry.",
    parameters: {
      type: "object",
      properties: {}, // no parameters needed
      additionalProperties: false,
    },
  },
} as const;

/**
 * Implementation:
 * Uses the public where-the-ISS-at API.
 * https://api.wheretheiss.at/v1/satellites/25544
 */
export async function getISS(): Promise<IssResult> {
    const url = "https://api.wheretheiss.at/v1/satellites/25544";
  
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) return { ok: false, error: `ISS API failed (${r.status})` };
  
      const j = (await r.json()) as unknown;
  
      const lat =
        typeof (j as { latitude?: unknown }).latitude === "number"
          ? (j as { latitude: number }).latitude
          : undefined;
      const lon =
        typeof (j as { longitude?: unknown }).longitude === "number"
          ? (j as { longitude: number }).longitude
          : undefined;
  
      if (typeof lat !== "number" || typeof lon !== "number") {
        return { ok: false, error: "Malformed response" };
      }
  
      const altitude_km =
        typeof (j as { altitude?: unknown }).altitude === "number"
          ? (j as { altitude: number }).altitude
          : undefined;
      const velocity_kmh =
        typeof (j as { velocity?: unknown }).velocity === "number"
          ? (j as { velocity: number }).velocity
          : undefined;
      const visibility =
        typeof (j as { visibility?: unknown }).visibility === "string"
          ? (j as { visibility: string }).visibility
          : undefined;
  
      return {
        ok: true,
        lat,
        lon,
        altitude_km,
        velocity_kmh,
        visibility,
        ts: Date.now(),
      };
    } catch {
      return { ok: false, error: "Network error" };
    }
  }
