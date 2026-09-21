# @shuttle/core

迷你插件容器，蒸馏自 Cordis（~200 行）。Shuttle 的全部组装都发生在这里。

## 职责

- **服务注册表**：`ctx.register(key, service)` → disposer；重复注册抛 `DUPLICATE_SERVICE`，`ctx.get(key)` 缺失抛 `MISSING_SERVICE`（绝不静默 `undefined`）。
- **typed events**：`interface ShuttleEventMap {}` / `interface ShuttleWaterfallMap {}` 由消费方 `declare module '@shuttle/core'` 扩充。
  - `emit(name, ...args)`：fire-and-forget，监听器异常被隔离并报告到 `onError`。
  - `serial(name, ...args)`：按注册顺序逐个 await。
  - `waterfall(name, value)`：监听器收到 `(value, next)`；**不调 `next` 即短路**，其返回值就是最终值；调了 `next` 必须 `return` 它的结果才能向下传递。
- **effect 生命周期**：`ctx.effect(fn)` 把 fn 返回的 disposer 压栈；`ctx.dispose()` 逆序回卷全部 effect。每条注册（服务、监听器、adapter）返回的 disposer 都可随时拆卸——这是 README 设计原则第 2 条。
- **插件**：`{ name, apply(ctx, config) }`，`ctx.plugin(def, config)` 执行 apply 并托管其返回的 disposer。

## 导出契约

`Context`、`PluginDef`、`Disposer`、`CoreError`（带 `code`）、`ShuttleEventMap` / `ShuttleWaterfallMap` / `ShuttleServiceMap`（declaration merging 扩展点）。
