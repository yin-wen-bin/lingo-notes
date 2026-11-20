# Lingo Notes bundled typography

`typography.css` imports `fonts.css` and provides language-aware font stacks. The Chrome extension copies this directory intact. Vite resolves the same relative WOFF2 files for the PWA.

| Theme | Chinese | English and numbers | Japanese |
|---|---|---|---|
| Handwritten | LXGW WenKai Screen | Lora | Klee One |
| Bookish | Noto Serif SC | Literata | Noto Serif JP |
| Clean | Noto Sans SC | DM Sans | Zen Kaku Gothic New |

Use `theme.ts` for the three theme IDs, labels and descriptions. `applyFontTheme` sets `data-font-theme` on the document root, and defaults are clean. Account persistence is handled by each application's settings client. Interface and learning text both use the selected theme. IPA remains on its dedicated sans-serif/system fallback stack.

Use `learning-text` with a reliable `lang` attribute for words, original sentences and translations. Use `learning-title` for target-language word headings. Each application uses the heading/button/title weight variables so screen WenKai stays at its real 400 weight and Klee headings use its real 600 weight. Serif variable fonts support 400–600, and clean Japanese headings use Zen Kaku Gothic New's 500 weight.

The CSS supplies font families and weights. Each application owns its existing font sizes, line heights and control dimensions.

All font files are locally bundled WOFF2 subsets with upstream Unicode ranges and `font-display: swap`. `manifest.json` records exact package versions, package integrity, font file SHA256 values and licenses. WenKai's Hangul-only subsets are omitted because Lingo Notes' selected scripts are Chinese, English and Japanese. All other WenKai subsets are retained. Lora includes Latin and extended Latin; other scripts fall back to the configured CJK or system fonts.

All nine fonts use SIL Open Font License 1.1. Corresponding copyright and license texts are in `licenses/`. The font bytes are copied from their version-pinned public packages without modification. The CSS uses the display family names while the underlying Fontsource variable fonts retain their original internal names.
