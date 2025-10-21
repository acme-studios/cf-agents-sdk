/// <reference lib="webworker" />
/**
 * Open-Meteo tool (geocode + daily forecast)
 * - Deterministic shape with friendly units
 * - Conservative timeouts + clear console logs
 */

export type WeatherArgs = {
    location?: string;                  // e.g., "Vancouver"
    lat?: number;                       // optional: direct coords
    lon?: number;
    units?: "metric" | "imperial";      // default "metric"
  };
  
  export type WeatherResult =
    | {
        ok: true;
        place: { name: string; region?: string; country?: string; timezone: string };
        units: { temp: "°C" | "°F" };
        daily: Array<{ date: string; tMin: number; tMax: number; pop: number; code?: number }>;
      }
    | { ok: false; error: string };
  
  const TAG = "[weather]";

  type GeocodeJson = {
    results?: Array<{
      latitude: number;
      longitude: number;
      name?: string;
      admin1?: string;
      country?: string;
    }>;
  };
  
  type ForecastJson = {
    timezone?: string;
    daily?: {
      time?: string[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
      weathercode?: number[];
    };
  };
  
  async function geocode(name: string, signal: AbortSignal) {
    const u = new URL("https://geocoding-api.open-meteo.com/v1/search");
    u.searchParams.set("name", name);
    u.searchParams.set("count", "1");
    u.searchParams.set("language", "en");
    console.log(TAG, "geocode →", u.toString());
  
    const r = await fetch(u.toString(), { signal });
    if (!r.ok) throw new Error(`geocode ${r.status}`);
    const j = (await r.json()) as unknown as GeocodeJson;
    const hit = Array.isArray(j.results) ? j.results[0] : null;
    if (!hit) throw new Error("no geocode results");
    return {
      lat: Number(hit.latitude),
      lon: Number(hit.longitude),
      name: String(hit.name || name),
      region: hit.admin1 ? String(hit.admin1) : undefined,
      country: hit.country ? String(hit.country) : undefined,
    };
  }
  
  export async function getWeather(args: WeatherArgs): Promise<WeatherResult> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 12_000);
  
    try {
      const units = args.units === "imperial" ? "imperial" : "metric";
      const wantF = units === "imperial";
  
      let lat = args.lat;
      let lon = args.lon;
      let name = "";
      let region: string | undefined;
      let country: string | undefined;
  
      if ((lat == null || lon == null) && args.location) {
        console.log(TAG, "geocoding:", args.location);
        const g = await geocode(args.location, ctrl.signal);
        lat = g.lat; lon = g.lon; name = g.name; region = g.region; country = g.country;
      }
  
      if (lat == null || lon == null) {
        return { ok: false, error: "Please provide a city/location I can find." };
      }
  
      const u = new URL("https://api.open-meteo.com/v1/forecast");
      u.searchParams.set("latitude", String(lat));
      u.searchParams.set("longitude", String(lon));
      u.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode");
      u.searchParams.set("timezone", "auto");
      u.searchParams.set("temperature_unit", wantF ? "fahrenheit" : "celsius");
  
      console.log(TAG, "fetch forecast →", u.toString());
      const r = await fetch(u.toString(), { signal: ctrl.signal });
      if (!r.ok) throw new Error(`forecast ${r.status}`);
      const j = (await r.json()) as unknown as ForecastJson;

      const tz = String(j.timezone || "UTC");
      const d = j.daily ?? {};
      const dates: string[] = Array.isArray(d.time) ? d.time : [];
      const tmax: number[] = Array.isArray(d.temperature_2m_max) ? d.temperature_2m_max : [];
      const tmin: number[] = Array.isArray(d.temperature_2m_min) ? d.temperature_2m_min : [];
      const pop: number[]  = Array.isArray(d.precipitation_probability_max) ? d.precipitation_probability_max : [];
      const codes: number[] = Array.isArray(d.weathercode) ? d.weathercode : [];

  
      const days = dates.map((date, i) => ({
        date,
        tMax: Number(tmax[i] ?? NaN),
        tMin: Number(tmin[i] ?? NaN),
        pop:  Number(pop[i]  ?? 0),
        code: Number.isFinite(codes[i]) ? Number(codes[i]) : undefined,
      })).filter(x => x && x.date);
  
      const place = {
        name: name || (args.location || `${lat!.toFixed(3)}, ${lon!.toFixed(3)}`),
        region,
        country,
        timezone: tz,
      };
  
      return {
        ok: true,
        place,
        units: { temp: wantF ? "°F" as const : "°C" as const },
        daily: days,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(TAG, "error:", msg);
      return { ok: false, error: "Failed to fetch forecast." };
    } finally {
      clearTimeout(timeout);
    }
  }
  
  /** Tool schema (optional: for future planner calls) */
  export const getWeatherToolSchema = {
    type: "function",
    function: {
      name: "getWeather",
      description: "Fetch a 5–7 day forecast using Open-Meteo and answer weather questions.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name, e.g., 'Vancouver'" },
          lat: { type: "number" },
          lon: { type: "number" },
          units: { type: "string", enum: ["metric", "imperial"] }
        }
      }
    }
  } as const;
  