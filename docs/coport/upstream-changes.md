# Coport 上游改动记录

基线为 Tabby v1.0.238（`54869e1`）。[规格中的白名单和同步流程](../specs/coport-fork.md#上游改动清单与同步流程)

| 上游文件 | 允许的改动 | 状态 |
|---|---|---|
| `app/yarn.lock` | 只更新新增的 `@xterm/headless`、`@xterm/addon-serialize`、`@modelcontextprotocol/sdk` 及其传递依赖的锁定记录。该文件由 Yarn 生成，`coport:` 标记登记在此。 | 编排方已批准，锁定记录待随依赖变更生成 |
