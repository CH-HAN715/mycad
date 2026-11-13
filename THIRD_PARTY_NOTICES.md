# 第三方组件与许可证

本项目以 Apache-2.0 发布（见 [LICENSE](LICENSE)）。下列第三方组件随项目分发或被引用：

## 运行时依赖

### manifold-3d 3.5.4

- 许可证：Apache-2.0
- 用途：仅 `mycad step --holes` 的布尔运算（扣钻孔），以 WASM 形式运行
- 来源：https://github.com/elalish/manifold
- 许可证全文：http://www.apache.org/licenses/LICENSE-2.0（与本项目 LICENSE 相同）
- 说明：manifold-3d 的 npm 包还声明了 GLTF/3MF 等可选工具链依赖；本项目只导入其核心
  `manifold.js`，这些依赖不进入几何、BOM 或校核代码路径。

## Vendored 组件

### three.js（浏览器 3D 预览）

- 许可证：MIT
- 位置：`src/serve/vendor/`
- 许可证全文：[src/serve/vendor/LICENSE](src/serve/vendor/LICENSE)
