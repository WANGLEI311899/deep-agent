import type { AgentTool } from '../tool-registry.js'
import {
  OpenMeteoWeather,
  extractWeatherLocation,
  type WeatherResult,
} from './open-meteo-weather.js'

interface WeatherToolInput {
  location: string
}

/**
 * Open-Meteo 是免 API Key 的天气数据源。
 * 将其包装成标准 AgentTool 后，Agent 核心不再包含天气专用分支。
 */
export function createWeatherTool(
  weather = new OpenMeteoWeather(),
): AgentTool<WeatherToolInput, WeatherResult> {
  return {
    name: 'weather_lookup',
    description: '查询中国城市的当前天气和两日预报',
    riskLevel: 'low',
    timeoutMs: 12_000,
    match(message) {
      const location = extractWeatherLocation(message)
      return location ? { location } : null
    },
    execute(input, context) {
      return weather.getWeather(input.location, context.signal)
    },
    toPrompt(output) {
      return [
        '数据来源：Open-Meteo',
        `观测时间：${output.observedAt}（${output.timezone}）`,
        JSON.stringify(output),
      ].join('\n')
    },
  }
}
