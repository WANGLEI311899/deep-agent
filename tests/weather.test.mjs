import assert from 'node:assert/strict'
import test from 'node:test'
import { extractWeatherLocation } from '../dist/tools/open-meteo-weather.mjs'

test('从中文天气问题中提取城市', () => {
  assert.equal(extractWeatherLocation('今天安徽池州天气怎么样？'), '安徽池州')
  assert.equal(extractWeatherLocation('请问北京明天会不会下雨'), '北京')
  assert.equal(
    extractWeatherLocation('今天安徽池州天气怎么样？请简短回答'),
    '安徽池州',
  )
})

test('非天气问题不触发天气工具', () => {
  assert.equal(extractWeatherLocation('帮我审查这段代码'), null)
})
