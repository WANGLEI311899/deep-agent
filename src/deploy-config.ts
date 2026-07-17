/**
 * 部署相关配置：访问口令、公网模式、限流。
 * 本地开发可不设 ACCESS_TOKEN / PUBLIC_MODE，行为与原来一致。
 */

function truthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export const deployConfig = {
  port: Number(process.env.PORT ?? 5173),
  /** 监听地址；容器/公网部署用 0.0.0.0 */
  host: process.env.HOST ?? '0.0.0.0',
  /** 访问口令；设置后所有 /api/*（除 health）需要携带 */
  accessToken: (process.env.ACCESS_TOKEN ?? '').trim(),
  /**
   * 公网共享模式：
   * - 强制要求 ACCESS_TOKEN
   * - 禁止自定义任意本机路径（只允许默认 output）
   */
  publicMode: truthy(process.env.PUBLIC_MODE),
  /** 每个 IP 每分钟 /api/chat 次数上限 */
  rateLimitPerMin: Math.max(1, Number(process.env.RATE_LIMIT_PER_MIN ?? 30)),
}

/** 是否启用鉴权 */
export function isAuthEnabled(): boolean {
  return Boolean(deployConfig.accessToken)
}

/** 启动前校验：公网模式必须设口令 */
export function assertDeployConfig(): void {
  if (deployConfig.publicMode && !deployConfig.accessToken) {
    throw new Error(
      'PUBLIC_MODE 已开启，但未设置 ACCESS_TOKEN。公网部署必须配置访问口令，请在环境变量中设置 ACCESS_TOKEN。',
    )
  }
}
