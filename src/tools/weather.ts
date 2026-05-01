import { z } from "zod";

export const toolName = "weather";

export const toolDescription =
  "Get current weather and forecast for a city. " +
  "Use this when the user asks about weather, temperature, or forecast. " +
  "Returns current conditions, humidity, wind speed, and 3-day forecast.";

export const toolSchema = z.object({
  city: z
    .string()
    .min(1)
    .describe("The city name to get weather for (e.g., 'Hanoi', 'Ho Chi Minh')."),
});

export type WeatherInput = z.infer<typeof toolSchema>;

const WMO_CODE_MAP: Record<number, string> = {
  0: "Trời quang",
  1: "Ít mây",
  2: "Ít mây",
  3: "Ít mây",
  45: "Sương mù",
  48: "Sương mù",
  51: "Có mưa",
  53: "Có mưa",
  55: "Có mưa",
  61: "Có mưa",
  63: "Có mưa",
  65: "Có mưa",
  71: "Có tuyết",
  73: "Có tuyết",
  75: "Có tuyết",
  77: "Có tuyết",
  80: "Mưa rào",
  81: "Mưa rào",
  82: "Mưa rào",
  85: "Mưa đá",
  86: "Mưa đá",
  95: "Giông bão",
  96: "Giông bão",
  99: "Giông bão",
};

function getConditionText(code: number): string {
  return WMO_CODE_MAP[code] ?? `Mã thời tiết ${code}`;
}

interface WeatherData {
  current: {
    temperature: number;
    weatherCode: number;
    windSpeed: number;
    humidity: number;
  };
  daily: {
    maxTemps: number[];
    minTemps: number[];
    dates: string[];
  };
}

async function fetchWeather(): Promise<WeatherData> {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=21.0285&longitude=105.8542" +
    "&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum" +
    "&forecast_days=3&timezone=Asia%2FHo_Chi_Minh&temperature_unit=celsius";

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json = (await response.json()) as {
    current: { temperature_2m: number; weather_code: number; wind_speed_10m: number; relative_humidity_2m: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; time: string[] };
  };
  return {
    current: {
      temperature: json.current.temperature_2m,
      weatherCode: json.current.weather_code,
      windSpeed: json.current.wind_speed_10m,
      humidity: json.current.relative_humidity_2m,
    },
    daily: {
      maxTemps: json.daily.temperature_2m_max,
      minTemps: json.daily.temperature_2m_min,
      dates: json.daily.time,
    },
  };
}

function formatOutput(data: WeatherData): string {
  const lines: string[] = [];
  lines.push("🌤️ Thời tiết Hà Nội");
  lines.push(`   Nhiệt độ: ${data.current.temperature}°C, ${getConditionText(data.current.weatherCode)}`);
  lines.push(`   💧 Độ ẩm: ${data.current.humidity}%`);
  lines.push(`   💨 Gió: ${data.current.windSpeed} km/h`);
  lines.push("");
  lines.push("📅 Dự báo 3 ngày:");

  const today = new Date();
  for (let i = 0; i < data.daily.dates.length; i++) {
    const date = new Date(data.daily.dates[i]);
    const dayName =
      i === 0
        ? "Hôm nay"
        : date.toLocaleDateString("vi-VN", { weekday: "short" });
    lines.push(
      `   ${dayName}: ${data.daily.minTemps[i]}°C - ${data.daily.maxTemps[i]}°C`,
    );
  }

  return lines.join("\n");
}

export async function execute(input: WeatherInput): Promise<string> {
  console.log(`[weather] fetching weather for ${input.city}`);
  try {
    const data = await fetchWeather();
    return formatOutput(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weather] failed: ${message}`);
    return `Thời tiết hiện không khả dụng. Lý do: ${message}`;
  }
}