// 在子进程启动前注入绝对 CA 路径，兼容 AVG HTTPS 扫描产生的本地证书链。
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// 第一个参数是构建后的 Demo 文件名，默认运行基础示例。
const demoFile = process.argv[2] ?? 'demo-basic.mjs'
const demoPath = resolve('dist', demoFile)
const caPath = resolve('.certs/avg-web-shield.pem')
const result = spawnSync(process.execPath, [demoPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_EXTRA_CA_CERTS: caPath,
  },
})

// 将子进程退出状态透传给 npm，便于 CI 和终端正确识别失败。
if (result.error) throw result.error
process.exitCode = result.status ?? 1
