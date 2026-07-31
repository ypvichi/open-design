/**
 * 品牌色色板生成器
 * 根据基准品牌色生成 10 阶色板（brand-10 ~ brand-100）
 *
 * 用法: node generate-palette.js <brandColor> [outputPath]
 * 示例: node generate-palette.js #E72528
 *       node generate-palette.js E72528 ./palette.json
 */

/**
 * HEX 颜色转 RGB
 * @param {string} hex - 6位HEX颜色（可带#前缀）
 * @returns {{r: number, g: number, b: number}}
 */
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length !== 6) {
    throw new Error('无效的 HEX 颜色格式，请使用 6 位 HEX（如 #E72528）');
  }
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16),
  };
}

/**
 * RGB 转 HEX
 * @param {number} r - 0-255
 * @param {number} g - 0-255
 * @param {number} b - 0-255
 * @returns {string} - 带 # 前缀的 6 位 HEX
 */
function rgbToHex(r, g, b) {
  const toHex = (n) => {
    const hex = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * RGB 转 HSL
 * @param {number} r - 0-255
 * @param {number} g - 0-255
 * @param {number} b - 0-255
 * @returns {{h: number, s: number, l: number}}
 */
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return {
    h: h * 360, // 0-360
    s: s * 100, // 0-100
    l: l * 100, // 0-100
  };
}

/**
 * HSL 转 RGB
 * @param {number} h - 0-360
 * @param {number} s - 0-100
 * @param {number} l - 0-100
 * @returns {{r: number, g: number, b: number}}
 */
function hslToRgb(h, s, l) {
  h /= 360;
  s /= 100;
  l /= 100;

  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

/**
 * 生成品牌色色板
 * 基于基准色的 HSL，按照预设规律生成 10 阶色板
 *
 * @param {string} brandHex - 基准品牌色（如 #E72528）
 * @returns {Object} - 色板对象
 */
function generatePalette(brandHex) {
  // 解析基准色
  const rgb = hexToRgb(brandHex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  const { h: baseH, s: baseS, l: baseL } = hsl;

  // 色板定义：每个色阶的 [色相偏移量, 饱和度%, 明度%]
  // 浅色端（tint）：S=100%，H 向暖色偏移，L 从 96.7% 递减
  // 深色端（shade）：S 递增至 100%，H 向冷色偏移，L 从 41.4% 递减
  const paletteDefinitions = {
    // 浅色端（tint）— 向白色混合，高饱和，色相偏暖
    10: { hOffset: 8.0, s: 100.0, l: 96.7 },
    20: { hOffset: 9.1, s: 100.0, l: 91.4 },
    30: { hOffset: 7.8, s: 100.0, l: 84.7 },
    40: { hOffset: 7.0, s: 100.0, l: 76.7 },
    50: { hOffset: 5.1, s: 100.0, l: 66.5 },

    // 基准色
    60: { hOffset: 0.0, s: baseS, l: baseL },

    // 深色端（shade）— 向黑色混合，S 递增，色相偏冷
    70: { hOffset: -1.3, s: 76.3, l: 41.4 },
    80: { hOffset: -2.8, s: 83.4, l: 30.8 },
    90: { hOffset: -4.4, s: 96.2, l: 20.8 },
    100: { hOffset: -2.8, s: 100.0, l: 12.7 },
  };

  const result = {};

  // 先生成基准色（brand-60）
  const baseKey = `--h-color-brand-60`;
  const baseColor = rgbToHex(rgb.r, rgb.g, rgb.b);
  result[baseKey] = baseColor;

  // 生成其他色阶
  for (const [level, def] of Object.entries(paletteDefinitions)) {
    if (level === '60') continue; // 基准色已处理

    const targetH = baseH + def.hOffset;
    const targetS = def.s;
    const targetL = def.l;

    const colorRgb = hslToRgb(targetH, targetS, targetL);
    const colorHex = rgbToHex(colorRgb.r, colorRgb.g, colorRgb.b);

    result[`--h-color-brand-${level}`] = colorHex;
  }

  // 添加主色变量（指向 brand-60）
  result['--h-color-primary'] = baseColor;

  return result;
}

/**
 * 智能生成色板（动态计算版）
 * 如果预设的固定偏移量不适合某些品牌色，可以使用此版本
 * 它基于基准色的 HSL 动态计算各阶颜色
 *
 * @param {string} brandHex - 基准品牌色
 * @returns {Object} - 色板对象
 */
function generatePaletteDynamic(brandHex) {
  const rgb = hexToRgb(brandHex);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const { h: baseH, s: baseS, l: baseL } = hsl;

  const result = {};

  // 浅色端参数（相对于基准色的比例）
  const lightSteps = [
    { level: 10, lFactor: 1.84, sTarget: 100, hShift: 4 },
    { level: 20, lFactor: 1.74, sTarget: 100, hShift: 5 },
    { level: 30, lFactor: 1.61, sTarget: 100, hShift: 5 },
    { level: 40, lFactor: 1.46, sTarget: 100, hShift: 5 },
    { level: 50, lFactor: 1.27, sTarget: 100, hShift: 4 },
  ];

  // 深色端参数
  const darkSteps = [
    { level: 70, lFactor: 0.79, sFactor: 0.95, hShift: -1 },
    { level: 80, lFactor: 0.59, sFactor: 1.04, hShift: -3 },
    { level: 90, lFactor: 0.40, sFactor: 1.20, hShift: -4 },
    { level: 100, lFactor: 0.24, sFactor: 1.25, hShift: -3 },
  ];

  // 生成浅色端
  for (const step of lightSteps) {
    const targetH = baseH + step.hShift;
    const targetS = step.sTarget;
    const targetL = Math.min(97, baseL * step.lFactor);

    const colorRgb = hslToRgb(targetH, targetS, targetL);
    result[`--h-color-brand-${step.level}`] = rgbToHex(colorRgb.r, colorRgb.g, colorRgb.b);
  }

  // 基准色
  const baseColor = rgbToHex(rgb.r, rgb.g, rgb.b);
  result['--h-color-brand-60'] = baseColor;

  // 生成深色端
  for (const step of darkSteps) {
    const targetH = baseH + step.hShift;
    const targetS = Math.min(100, baseS * step.sFactor);
    const targetL = baseL * step.lFactor;

    const colorRgb = hslToRgb(targetH, targetS, targetL);
    result[`--h-color-brand-${step.level}`] = rgbToHex(colorRgb.r, colorRgb.g, colorRgb.b);
  }

  result['--h-color-primary'] = baseColor;

  return result;
}

// ==================== CLI 入口 ====================

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
品牌色色板生成器

用法: node generate-palette.js <brandColor> [outputPath] [--dynamic]

参数:
  brandColor   基准品牌色，6位HEX（如 #E72528 或 E72528）
  outputPath   输出文件路径（可选，默认输出到控制台）
  --dynamic    使用动态计算模式（可选，默认使用固定偏移量模式）

示例:
  node generate-palette.js E72528
  node generate-palette.js E72528 ./palette.css
  node generate-palette.js E72528 ./palette.css --dynamic
`);
    process.exit(0);
  }

  const brandColor = args[0];
  const outputPath = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const useDynamic = args.includes('--dynamic');

  try {
    // 生成色板
    const generator = useDynamic ? generatePaletteDynamic : generatePalette;
    const palette = generator(brandColor);

    // 按品牌色阶排序
    const keyOrder = [
      '--h-color-primary',
      '--h-color-brand-10',
      '--h-color-brand-20',
      '--h-color-brand-30',
      '--h-color-brand-40',
      '--h-color-brand-50',
      '--h-color-brand-60',
      '--h-color-brand-70',
      '--h-color-brand-80',
      '--h-color-brand-90',
      '--h-color-brand-100',
    ];

    // 输出 CSS :root 格式
    const cssVars = keyOrder
      .filter((key) => palette[key])
      .map((key) => `  ${key}: ${palette[key]};`)
      .join('\n');
    const output = `:root {\n${cssVars}\n}`;

    if (outputPath) {
      const fs = require('fs');
      fs.writeFileSync(outputPath, output + '\n', 'utf-8');
      console.log(`✅ 色板已生成: ${outputPath}`);
    } else {
      console.log(output);
    }
  } catch (error) {
    console.error(`❌ 错误: ${error.message}`);
    process.exit(1);
  }
}

main();
