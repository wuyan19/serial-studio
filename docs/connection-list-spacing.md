# 连接列表间距

默认视图和分组视图共用 `ui/src/styles.css` 中 `.connection-tree` 的变量，不分别定义卡片边距。

| 层级 / 间距 | 变量 | 标准值 |
| --- | --- | --- |
| 顶层设备、SSH 设备、分组标题 | `--connection-row-height` | 最小 38px |
| 展开后的串口 / SSH 子项 | `--connection-child-row-height` | 最小 34px |
| 相邻行、组标题到首个子项 | `--connection-row-gap` | 2px |
| 展开组末尾到下一顶层条目 | `--connection-group-gap` | 6px |
| 子项相对组标题的缩进 | `--connection-indent` | 16px |

收起后的组只保留顶层标题，与下一行间隔 2px；没有额外卡片内边距或分隔线占位。展开时通过同一个 children 容器组织子项，末尾补齐 6px 组间距。最后一组不依赖后续行间隔。

行高使用最小高度；用户放大字号时，内容可以自然撑高。宏 / 脚本库的分组样式独立保留。
