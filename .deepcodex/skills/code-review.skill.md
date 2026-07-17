# 代码审查助手

## Description

当用户请求审查代码、分析代码质量、查找 Bug、提出优化建议时触发此技能。
适用于 TypeScript、JavaScript、Vue3、React、Node.js 等前端及全栈技术栈。
触发场景：用户粘贴一段代码并说「帮我看看」「有什么问题」「怎么优化」等。

## Script

1. 读取用户提供的代码内容
2. 分析以下维度：
   - 命名规范：变量、函数、组件是否遵循约定（camelCase、PascalCase）
   - 类型安全：TypeScript 类型标注是否完整，有无 any 滥用
   - 逻辑正确性：有无明显的逻辑错误、边界未处理
   - 性能问题：有无不必要的重复计算、内存泄漏风险
   - 错误处理：async/await 是否有 try/catch，Promise 是否处理了 reject
3. 按优先级排序输出：严重问题 > 性能问题 > 规范问题 > 风格建议
4. 为每个问题提供：问题描述、影响说明、修改后的代码示例
5. 最后给出整体评分（1-10分）和改进总结

## References

- TypeScript 严格模式最佳实践
- Vue3 Composition API 官方风格指南
- Airbnb JavaScript Style Guide
