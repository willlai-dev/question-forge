// 供 node10 模組解析使用的轉接檔（apps/api 的 tsconfig 使用 moduleResolution: Node）。
// 讓 `@repo/contracts/server` 能解析到 dist 中的伺服器專用進入點。
module.exports = require('./dist/server.js');
