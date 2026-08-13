/**
 * Tavily 搜索工具 — AgentTool 包装器。
 * 将 TavilySearch 实例桥接到 ToolRegistry，使 Agent 能自动触发网络搜索。
 */
import type { AgentTool } from '../tool-registry.js'
import { TavilySearch, type SearchResult } from './tavily-search.js'

interface TavilySearchInput {
  query: string
  maxResults?: number
}

/** 从用户消息中检测搜索意图并提取查询词；无意图返回 null。 */
function extractSearchQuery(message: string): TavilySearchInput | null {
  const patterns: Array<RegExp> = [
    /搜索[：:]\s*(.+)/i,
    /查找[：:]\s*(.+)/i,
    /帮我查[一]?下[：:]?\s*(.+)/i,
    /search\s+(?:for\s+)?(.+)/i,
    /(.+)\s*(?:是什么|怎么回事|最新消息|最新进展|的最新)/,
    /帮我搜[一]?下[：:]?\s*(.+)/i,
  ]
  for (const pattern of patterns) {
    const match = message.match(pattern)
    const query = (match?.[1] ?? '').trim()
    if (query.length >= 2) {
      // 取最后一个匹配组（去除问号等尾随字符）
      return { query: query.replace(/[？?！!。.]*$/g, '').trim() }
    }
  }
  return null
}

/**
 * 将 TavilySearch 实例包装为 AgentTool。
 * @param tavily 已配置 API Key 的 TavilySearch 实例
 */
export function createTavilySearchTool(
  tavily = new TavilySearch(process.env.TAVILY_API_KEY ?? ''),
): AgentTool<TavilySearchInput, SearchResult[]> {
  return {
    name: 'tavily_search',
    description: '搜索互联网获取最新信息',
    riskLevel: 'low',
    timeoutMs: 20_000,
    match(message) {
      return extractSearchQuery(message)
    },
    async execute(input, context) {
      return tavily.search(input.query, input.maxResults ?? 5)
    },
    toPrompt(output) {
      if (!output.length) return '搜索未返回结果。'
      return output
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   来源：${r.url}\n   摘要：${r.content}`,
        )
        .join('\n\n')
    },
  }
}
