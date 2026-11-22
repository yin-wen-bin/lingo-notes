# Lingo Notes bundled typography

`typography.css` imports `fonts.css` and provides language-aware font stacks. The Chrome extension bundles the stylesheets, WOFF2 files and licenses. Vite resolves the same relative WOFF2 files for the PWA.

| Theme | Chinese | English and numbers | Japanese |
|---|---|---|---|
| Handwritten | LXGW WenKai Screen | Lora | Klee One |
| Bookish | Noto Serif SC | Literata | Noto Serif JP |
| Clean | Noto Sans SC | DM Sans | Zen Kaku Gothic New |
| Refined (default) | Noto Sans SC | Manrope headings/buttons; Inter body | Noto Sans JP |

Use `theme.ts` for the four theme IDs, labels and descriptions. `applyFontTheme` sets `data-font-theme` on the document root, and absent or invalid values default to refined. Account persistence is handled by each application's settings client. Existing explicit handwritten, bookish and clean choices remain valid. IPA remains on its dedicated sans-serif/system fallback stack.

The refined scheme uses real 600 headings and 500 body/button weights. `--font-ui` / `--font-ui-ja` define body families; `--font-ui-heading` / `--font-ui-heading-ja` define heading families; `--font-ui-button` / `--font-ui-button-ja` define button families. `--font-body-weight` is 500 for refined and 400 for the original schemes. Learning headings use `--font-learning-title-zh` / `--font-learning-title-en` / `--font-learning-title-ja` together with the existing title weight variables. All three older schemes explicitly reset the new roles to their existing families and weights.

Use `learning-text` with a reliable `lang` attribute for words, original sentences and translations. Use `learning-title` for target-language word headings. Each application uses the heading/button/title weight variables so screen WenKai stays at its real 400 weight and Klee headings use its real 600 weight. Serif variable fonts support 400–600, and clean Japanese headings use Zen Kaku Gothic New's 500 weight.

The CSS supplies font families and weights. Each application owns its existing font sizes, line heights and control dimensions.

All font files are locally bundled WOFF2 subsets with upstream Unicode ranges and `font-display: swap`. `manifest.json` records exact package versions, package integrity, font file SHA256 values and licenses. WenKai's Hangul-only subsets are omitted because Lingo Notes' selected scripts are Chinese, English and Japanese. All other WenKai subsets are retained. Lora includes Latin and extended Latin; other scripts fall back to the configured CJK or system fonts.

All twelve bundled fonts use SIL Open Font License 1.1. Corresponding copyright and license texts are in `licenses/`. The font bytes are copied from their version-pinned public packages without modification. The CSS uses the display family names while the underlying Fontsource variable fonts retain their original internal names. Manrope is the Google Fonts / Fontsource OFL distribution (`@fontsource-variable/manrope` 5.3.0, upstream v20), not the separately licensed Manrope V5. Inter uses its weight-variable text design from `wght.css`; Latin and extended Latin are bundled for the two new English families. Noto Sans JP retains every upstream normal weight-variable Unicode subset.
