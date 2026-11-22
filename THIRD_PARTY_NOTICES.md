# Third-party materials

The root MIT license applies to Lingo Notes project code. It does not replace the licenses of dependencies, fonts or third-party artwork.

## Fonts

The twelve bundled font families are DM Sans, Zen Kaku Gothic New, Noto Sans SC, Lora, LXGW WenKai Screen, Klee One, Literata, Noto Serif SC, Noto Serif JP, Inter, Manrope and Noto Sans JP. Their individual SIL Open Font License texts, copyright notices and provenance are preserved in `shared/typography/licenses/`, `shared/typography/README.md` and `shared/typography/manifest.json`. Manrope uses the Google Fonts OFL release, not the separately licensed Manrope V5. These files are also included in builds. Font files are not relicensed under this project's MIT license.

## Pronunciation image

`extension/assets/pronunciation.png` comes from Youdao Dictionary (NetEase Youdao). Source and attribution are recorded in `extension/assets/README.md`. It is **not covered by the Lingo Notes MIT license**. This repository does not claim ownership or an open-source redistribution license for that image. The project owner has chosen to retain it and handles the permission separately. Anyone redistributing it must independently ensure they have the necessary rights; attribution alone does not grant those rights.

## Dependencies

The search, delete, image and screen-capture icons come from [Heroicons v2.2.0](https://github.com/tailwindlabs/heroicons/tree/v2.2.0), copyright Tailwind Labs, Inc., under its MIT license. The original license is preserved at `extension/assets/ui/HEROICONS-LICENSE.txt` and included in extension builds. Only the stroke color was changed.

JavaScript dependencies retain their own licenses. Exact versions and package sources are recorded in `package-lock.json`; installing dependencies does not change their licenses. No Node.js runtime binary is distributed in the Chrome extension.
