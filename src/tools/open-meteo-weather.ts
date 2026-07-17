/** Open-Meteo 天气工具：城市解析 + 当前天气 + 两日预报。 */

export interface WeatherResult {
  location: string
  latitude: number
  longitude: number
  timezone: string
  observedAt: string
  current: {
    temperature: number
    apparentTemperature: number
    humidity: number
    weatherCode: number
    weather: string
    windSpeed: number
  }
  daily: Array<{
    date: string
    temperatureMax: number
    temperatureMin: number
    precipitationProbability: number
    weatherCode: number
    weather: string
  }>
  source: 'Open-Meteo'
}

interface CacheEntry {
  expiresAt: number
  value: WeatherResult
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

const WEATHER_CODES: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '局部多云',
  3: '阴天',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '较强毛毛雨',
  56: '轻微冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '轻微冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷雨',
  96: '雷雨伴小冰雹',
  99: '强雷雨伴冰雹',
}

function weatherText(code: number): string {
  return WEATHER_CODES[code] ?? `未知天气代码 ${code}`
}

/** 从常见中文问法中提取地点；返回 null 表示不是天气请求。 */
export function extractWeatherLocation(message: string): string | null {
  const marker = message.match(/天气预报|天气|气温|温度|下雨|降雨|降雪/i)
  if (!marker || marker.index === undefined) return null

  // 地点通常出现在天气关键词前；忽略后面的“请简短回答”等输出要求。
  const beforeMarker = message.slice(0, marker.index)
  const cleaned = beforeMarker
    .replace(/[？?！!。,.，]/g, ' ')
    .replace(/(今天|今日|现在|当前|明天|后天|最近|查询|查一下|帮我看看|请问)/g, ' ')
    .replace(/(会不会|是否|有没有|怎么样|如何|情况)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // 中文场景默认使用最后一个较短片段作为城市或“省+城市”名称。
  const candidate = cleaned.split(' ').filter(Boolean).at(-1) ?? ''
  return candidate.length >= 2 && candidate.length <= 20 ? candidate : null
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export class OpenMeteoWeather {
  async getWeather(location: string, signal?: AbortSignal): Promise<WeatherResult> {
    const key = location.trim().toLowerCase()
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const requestSignal = combinedSignal(signal)
    const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search')
    geoUrl.search = new URLSearchParams({
      name: location,
      count: '1',
      language: 'zh',
      countryCode: 'CN',
    }).toString()

    const geoResponse = await fetch(geoUrl, { signal: requestSignal })
    if (!geoResponse.ok) throw new Error(`城市查询失败：HTTP ${geoResponse.status}`)
    const geo = (await geoResponse.json()) as {
      results?: Array<{
        name: string
        admin1?: string
        admin2?: string
        latitude: number
        longitude: number
      }>
    }
    const place = geo.results?.[0]
    if (!place) throw new Error(`没有找到城市“${location}”`)

    const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast')
    forecastUrl.search = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current:
        'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
      daily:
        'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
      timezone: 'auto',
      forecast_days: '2',
    }).toString()

    const weatherResponse = await fetch(forecastUrl, { signal: requestSignal })
    if (!weatherResponse.ok) {
      throw new Error(`天气查询失败：HTTP ${weatherResponse.status}`)
    }
    const data = (await weatherResponse.json()) as {
      timezone: string
      current: {
        time: string
        temperature_2m: number
        apparent_temperature: number
        relative_humidity_2m: number
        weather_code: number
        wind_speed_10m: number
      }
      daily: {
        time: string[]
        temperature_2m_max: number[]
        temperature_2m_min: number[]
        precipitation_probability_max: number[]
        weather_code: number[]
      }
    }

    const displayLocation = [place.admin1, place.admin2, place.name]
      .filter((part, index, all) => part && all.indexOf(part) === index)
      .join(' · ')
    const result: WeatherResult = {
      location: displayLocation,
      latitude: place.latitude,
      longitude: place.longitude,
      timezone: data.timezone,
      observedAt: data.current.time,
      current: {
        temperature: data.current.temperature_2m,
        apparentTemperature: data.current.apparent_temperature,
        humidity: data.current.relative_humidity_2m,
        weatherCode: data.current.weather_code,
        weather: weatherText(data.current.weather_code),
        windSpeed: data.current.wind_speed_10m,
      },
      daily: data.daily.time.map((date, index) => ({
        date,
        temperatureMax: data.daily.temperature_2m_max[index],
        temperatureMin: data.daily.temperature_2m_min[index],
        precipitationProbability:
          data.daily.precipitation_probability_max[index],
        weatherCode: data.daily.weather_code[index],
        weather: weatherText(data.daily.weather_code[index]),
      })),
      source: 'Open-Meteo',
    }

    cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS })
    return result
  }
}
